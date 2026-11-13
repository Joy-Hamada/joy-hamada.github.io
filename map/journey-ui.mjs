const districts = {
  apps: '画面と操作をつくる場所。', lib: 'データを読み、判定し、画面へ渡す場所。', docs: '問い・仕様・決定・検証を残す場所。',
  tests: '期待する動きを確かめる場所。', scripts: '開発と運用を支える道具。', assets: '画面に使う視覚素材。', infra: 'システムを動かす環境の設定。',
};
const modules = {
  'apps/mosaic': 'コードの構造を、平面の図として探索する画面。',
  'apps/world': 'プロジェクトを3Dの空間として見る画面。',
  'apps/towns': 'モジュールを街の区画として歩く画面。',
  'apps/graph': '所属・コード参照・文書リンクを図でたどる画面。',
  'apps/studies': 'VueとVS Codeの構成を読み比べる画面。',
  'apps/viewer': '試験の結果と証拠の有無を読む画面。',
  'apps/target': '二つの架空チームが資料を共有する試験用システム。',
  'apps/brand': 'XOZUのロゴと画面で使う素材。',
  'lib/evidence': '結果の証拠を保存し、判定できる状態か確かめる。',
  'lib/audit': '処理に対応するログが残ったか確かめる。',
  'lib/public-studies': '公開リポジトリの構成と参照を読み取る。',
  'lib/mosaic': '図へ渡すファイルの目録を用意する。',
  'lib/viewer': 'ローカル画面とデータの読取を提供する。',
  'lib/git-graph': 'Gitのファイルと参照関係を図のデータにする。',
  'lib/git-city': 'Gitの構成や変更を街のデータにする。',
  'docs/issues': '何を解き、何をもって完了とするかを記録する。',
  'docs/pull-requests': '変更・確認結果・次の課題を短く残す。',
  'docs/decisions': '選んだ案と、選ばなかった理由を残す。',
  'docs/spec-driven-dev': '要件・設計・作業・検証結果をつなぐ。',
  'docs/research': '先行研究から借りる原則と限界を残す。',
  'docs/learning': '自分の言葉で振り返るための学習メモ。',
};
const kinds = {code:'コード',test:'試験',document:'文書',config:'設定',asset:'素材',other:'ファイル'};

export function summarizeStrataPlace(node, state) {
  if (!node.id) return {text:'全体',basis:'プロジェクトの案内'};
  if (!state.presentFiles) return {text:state.presence==='absent-after-observation'?'削除済み':'未出現',basis:'選んだ版のGit目録'};
  const matched=Object.keys(modules).sort((a,b)=>b.length-a.length).find(path=>node.path===path||node.path.startsWith(`${path}/`));
  if(matched) return {text:node.path===matched?modules[matched]:`${modules[matched]} その中の${node.type==='file'?(kinds[state.file?.kind]??'ファイル'):'下位領域'}。`,basis:'所属に基づく案内。個々の実装機能の解析ではありません'};
  const top=node.path.split('/')[0];
  if(districts[top])return {text:node.path===top?districts[top]:`${districts[top]} ここは${node.type==='file'?(kinds[state.file?.kind]??'ファイル'):'下位のフォルダ'}。`,basis:'所属と種類に基づく案内'};
  return {text:'役割未登録',basis:'役割未登録'};
}

export function describeStrataActivity(activity) {
  if(activity?.unit==='modified-first-parent-commits-per-observed-file')return `内容編集 ${activity.meanChanges.toFixed(1)}回 / ファイル平均 · ${activity.observedFiles}ファイル`;
  if(!activity||activity.status==='baseline-unknown')return '編集活動：未集計';
  if(!activity.observedFiles)return '編集活動：未観測';
  return `変更区間 ${activity.meanChanges.toFixed(1)}回 / ファイル平均 · ${activity.observedFiles}ファイル`;
}

export function canTurnJourneyCard({top,bottom,viewportHeight,deltaY}) {
  return deltaY > 0 ? bottom <= viewportHeight - 8 : top >= 8;
}

export function createJourneyWheel() {
  let lastEvent=-Infinity, lastTurn=-Infinity, accumulated=0, direction=0, consumed=false;
  return {
    reset(){lastEvent=-Infinity;lastTurn=-Infinity;accumulated=0;direction=0;consumed=false;},
    accept({deltaY,deltaX=0,deltaMode=0,ctrlKey=false,time,index,count}) {
      if(ctrlKey||!Number.isFinite(deltaY)||!Number.isFinite(time)||Math.abs(deltaX)>Math.abs(deltaY)||!deltaY)return {handled:false,step:0};
      const sign=Math.sign(deltaY);
      if(sign<0&&index===0||sign>0&&index>=count-1)return {handled:false,step:0};
      const quiet=time-lastEvent>180;
      if(quiet||sign!==direction){accumulated=0;consumed=false;}
      lastEvent=time;direction=sign;
      if(consumed||time-lastTurn<550)return {handled:true,step:0};
      accumulated+=deltaY*(deltaMode===1?16:deltaMode===2?600:1);
      if(Math.abs(accumulated)<70)return {handled:true,step:0};
      consumed=true;lastTurn=time;accumulated=0;
      return {handled:true,step:sign};
    },
  };
}
export function resolveJourneyFrame(frames, revision) {
  if (!revision) return 0;
  const index = frames.findIndex(frame => frame.revision === revision);
  if (index < 0) throw new Error('project-map-snapshot-requested-revision-missing');
  return index;
}
