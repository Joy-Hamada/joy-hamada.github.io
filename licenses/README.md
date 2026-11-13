# 配色の出典とライセンス

更新・取得確認：2026-11-12。対象は`apps/project-map/map-palette.mjs`の配色C（識別子`set3`、配信先`map/map-palette.mjs`）。XOZU全体のライセンスを定める文書ではない。

## ColorBrewer

This product includes color specifications and designs developed by Cynthia Brewer (http://colorbrewer.org/).

Copyright (c) 2002 Cynthia Brewer, Mark Harrower, and The Pennsylvania State University.

- 配色の一次資料：[ColorBrewer公式JSON](https://colorbrewer2.org/export/colorbrewer.json)の`Set3[12]`。
- [ColorBrewer側のライセンス原文](ColorBrewer-Apache-2.0.txt)は[公式LICENSE.txt](https://colorbrewer2.org/export/LICENSE.txt)を変更せず保存。
- 参照される[Apache License 2.0本文](Apache-2.0.txt)も[Apache公式](https://www.apache.org/licenses/LICENSE-2.0.txt)から変更せず保存。

## XOZUでの変更

2026-11-12、XOZUが次を追加した。ColorBrewer原作の機能や保証とは区別する。

1. Set3の12色から灰色`#D9D9D9`と最も淡い黄色`#FFFFB3`を除き、残る10色の順序と基準色を保持。
2. lowは`#B8B8B2`から基準色へRGBで55%補間。highは重み付きRGBの灰色値を基準に各チャンネルの差を1.25倍へ拡張し、0〜255へ収めて丸める。
3. 編集活動0/2/8回をlow/base/highへ対応させ、その間を固定対数尺度とRGB補間で表示する。

A/Bは本人が2026-11-12に指定した10系統×3段階の色値であり、ColorBrewer由来ではない。配色Cの低/高活動色はXOZU独自調整で、色覚やコントラストへの適合を保証しない。ColorBrewerの名称は配色の出所の説明であり、XOZUの推奨・承認を表さない。
