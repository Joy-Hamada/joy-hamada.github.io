import { buildRevisionTown } from './rebuild-model.mjs';

export const libraryLayoutPolicy = 'revision-library-v1';
export const libraryShelfGeometry = Object.freeze({ innerRadius: 148, rowSpacing: 34, bookDepth: 23, bookPitch: 12 });
const fullTurn = Math.PI * 2;
const categoryOrder = ['apps','lib','docs','tests','scripts','assets','infra','.github','.agents','.claude','snapshots','licenses'];
const fileKinds = new Set(['code','test','document','asset','config','other']);
const pointAt = (radius, angle) => ({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });

export function libraryNodeContainsPoint(node, point) {
  if(!Number.isFinite(point?.x)||!Number.isFinite(point?.y))return false;
  const shelves=node.book?[node.book]:node.shelves;
  if(!shelves)return point.x>=node.bounds.minX&&point.x<=node.bounds.maxX&&point.y>=node.bounds.minY&&point.y<=node.bounds.maxY;
  const radius=Math.hypot(point.x,point.y),angle=Math.atan2(point.y,point.x);
  return shelves.some(shelf=>{
    let unwrapped=angle;while(unwrapped<shelf.startAngle-1e-10)unwrapped+=fullTurn;
    return radius>=shelf.innerRadius-1e-8&&radius<=shelf.outerRadius+1e-8&&unwrapped<=shelf.endAngle+1e-10;
  });
}

export function libraryArcPolygon(innerRadius, outerRadius, startAngle, endAngle) {
  const steps = Math.max(1, Math.ceil((endAngle - startAngle) / (Math.PI / 24)));
  const outer = Array.from({length:steps+1},(_,index)=>pointAt(outerRadius,startAngle+(endAngle-startAngle)*index/steps));
  const inner = Array.from({length:steps+1},(_,index)=>pointAt(innerRadius,endAngle-(endAngle-startAngle)*index/steps));
  return [...outer,...inner];
}

function assignPolygons(node, polygons) {
  node.polygons = polygons; node.polygon = polygons[0];
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const polygon of polygons)for(const point of polygon){minX=Math.min(minX,point.x);minY=Math.min(minY,point.y);maxX=Math.max(maxX,point.x);maxY=Math.max(maxY,point.y);}
  node.bounds={minX,minY,maxX,maxY,width:maxX-minX,height:maxY-minY};
  node.x=minX;node.y=minY;node.width=maxX-minX;node.height=maxY-minY;
  node.center={x:(minX+maxX)/2,y:(minY+maxY)/2};
}

function categoryRank(name) { const rank=categoryOrder.indexOf(name); return rank<0?categoryOrder.length:rank; }
function lexical(first,second) { return first<second?-1:first>second?1:0; }

export function buildRevisionLibrary(frame) {
  // Reuse the validated inventory tree; neither Git claims nor a future catalog can add books.
  const tree=buildRevisionTown(frame), {root,nodes,orderedNodes,landmarks}=tree;
  const metadata=new Map(frame.files.map(file=>[file.path,file]));
  const leaves=orderedNodes.filter(node=>node.type==='file');
  const groups=new Map();
  for(const leaf of leaves){
    const category=leaf.path.includes('/')?leaf.path.split('/')[0]:'';
    if(!groups.has(category))groups.set(category,{path:category,files:[]});
    groups.get(category).files.push(leaf);
    leaf.kind=fileKinds.has(metadata.get(leaf.path).kind)?metadata.get(leaf.path).kind:'other'; leaf.theme='book';
  }
  const sectors=[...groups.values()].sort((first,second)=>categoryRank(first.path)-categoryRank(second.path)||lexical(first.path,second.path));
  const totalWeight=sectors.reduce((sum,sector)=>sum+Math.sqrt(sector.files.length),0);
  const aisle=Math.min(.08,fullTurn/Math.max(1,sectors.length)*.15);
  const usableAngle=fullTurn-aisle*sectors.length;
  const folderRows=new Map(); let cursor=-Math.PI/2, outerRadius=148;
  for(const sector of sectors){
    sector.startAngle=cursor+aisle/2;sector.endAngle=sector.startAngle+usableAngle*Math.sqrt(sector.files.length)/totalWeight;
    sector.fileCount=sector.files.length;sector.rows=[];let consumed=0,row=0;
    while(consumed<sector.files.length){
      const innerRadius=libraryShelfGeometry.innerRadius+row*libraryShelfGeometry.rowSpacing;
      const outer=innerRadius+libraryShelfGeometry.bookDepth;
      const span=sector.endAngle-sector.startAngle;
      const capacity=Math.max(1,Math.floor(span*innerRadius/libraryShelfGeometry.bookPitch));
      const count=Math.min(capacity,sector.files.length-consumed);
      const step=span/capacity;const usedSpan=step*count;const rowStart=sector.startAngle+(span-usedSpan)/2;
      const shelf={innerRadius,outerRadius:outer,startAngle:rowStart,endAngle:rowStart+usedSpan,row,path:sector.path,count};
      sector.rows.push(shelf);outerRadius=Math.max(outerRadius,outer);
      for(let index=0;index<count;index++){
        const leaf=sector.files[consumed+index],startAngle=rowStart+step*(index+.1),endAngle=rowStart+step*(index+.9);
        leaf.book={innerRadius:innerRadius+2,outerRadius:outer-2,startAngle,endAngle,row,sector:sector.path};
        assignPolygons(leaf,[libraryArcPolygon(leaf.book.innerRadius,leaf.book.outerRadius,startAngle,endAngle)]);
        leaf.center=pointAt((innerRadius+outer)/2,(startAngle+endAngle)/2);
        let parentId=leaf.parentId;
        while(parentId){
          if(!folderRows.has(parentId))folderRows.set(parentId,new Map());
          const rows=folderRows.get(parentId),current=rows.get(row);
          if(current){current.startAngle=Math.min(current.startAngle,startAngle);current.endAngle=Math.max(current.endAngle,endAngle);}
          else rows.set(row,{innerRadius,outerRadius:outer,startAngle,endAngle,row});
          parentId=nodes.get(parentId).parentId;
        }
      }
      consumed+=count;row++;
    }
    sector.outerRadius=sector.rows.at(-1).outerRadius;
    sector.center=pointAt((148+sector.outerRadius)/2,(sector.startAngle+sector.endAngle)/2);
    delete sector.files;cursor=sector.endAngle+aisle/2;
  }
  for(const node of orderedNodes)if(node.id&&node.type==='folder'){
    node.theme='shelf';node.shelves=[...folderRows.get(node.id).values()];
    assignPolygons(node,node.shelves.map(shelf=>libraryArcPolygon(shelf.innerRadius,shelf.outerRadius,shelf.startAngle,shelf.endAngle)));
    const longest=node.shelves.reduce((best,shelf)=>(shelf.endAngle-shelf.startAngle)*shelf.innerRadius>(best.endAngle-best.startAngle)*best.innerRadius?shelf:best);
    node.center=pointAt((longest.innerRadius+longest.outerRadius)/2,(longest.startAngle+longest.endAngle)/2);
  }
  const extent=outerRadius+30;
  assignPolygons(root,[[{x:-extent,y:-extent},{x:extent,y:-extent},{x:extent,y:extent},{x:-extent,y:extent}]]);
  root.hubBounds={minX:-112,minY:-148,maxX:112,maxY:70,width:224,height:218};
  root.center={x:0,y:0};root.theme='totem';
  const kinds=[...new Set(leaves.map(file=>file.kind))].sort();
  const tower={levels:Math.min(9,2+Math.floor(Math.log2(root.fileCount+1)/1.7)),kinds,
    ornaments:Math.min(12,landmarks.length),fileCount:root.fileCount,folderCount:orderedNodes.filter(node=>node.type==='folder'&&node.id).length};
  return {...tree,policy:libraryLayoutPolicy,id:`${libraryLayoutPolicy}:${frame.revision}`,sectors,books:leaves,tower,outerRadius,
    mapping:{book:'one-current-file',shelf:'real-folder-membership',tower:'bounded-log-current-file-count-and-current-kinds'}};
}
