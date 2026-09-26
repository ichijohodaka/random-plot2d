# random-plot2d

いくつかの多変数関数があるとき、**変数と関数値の中から任意に2つを選んで**、
その関係を散布図にする。

n 個の変数 x = (x₁, …, xₙ) をそれぞれの区間の中で乱数に振り、
m 個の関数値 y = (f₁(x), …, fₘ(x)) を求める。1点は Z = (x, y) ∈ ℝⁿ⁺ᵐ で、
その n+m 本の列から横軸と縦軸を1本ずつ選ぶ。

回路には依存しない。WPT 回路の各素子の平均電力を
（[wpt-symbolic-ac-analysis-20260914](https://github.com/ichijohodaka/wpt-symbolic-ac-analysis-20260914)）
描くのに使うことを想定しているが、それは応用側がモデルを渡すだけで済む。

```powershell
start demo.html                            # 見本（直列 RLC）。ダブルクリックでもよい
go run ./cmd/rp2page -o rlc.html           # 1枚で完結する HTML にする
go run ./cmd/rp2page -model my.js -o my.html
```

## 画面でできること

- **変数**
  - ホイールで**幅**を増減する（Shift で細かく）。中心は動かない
  - 値の欄の上でホイールを回すと**中心**が動く。欄には `100u` や `4.7k` のように書ける
  - **幅 0 は固定値**で、乱数ではなくその値をとる。初めは全部幅 0
  - 幅を広げると、その区間の中から一様乱数（対数一様の変数なら桁の上で一様）で選ぶ
- **軸**
  - 横軸・縦軸それぞれに、変数・関数のどれでも選べる
  - それぞれ lin / log を切り替えられる
- **表示範囲で振る**（軸が変数のとき）
  - その変数の乱数の区間を、表示範囲そのものにする
  - パン・ズームのたびに取り直すので、拡大しても点が粗くならない
  - wptac の横軸の使い心地はこれで出る
- **ズーム**
  - 目盛りの帯の上でホイールを回すと、その軸だけ拡大・縮小する
  - 描画域の上なら両軸を拡大・縮小する
- **パン**
  - ドラッグで見ている場所を動かす
  - 目盛りの帯の上でドラッグすると、その軸だけ動く
- **自動スケーリング**
  - 0.5〜99.5% の分位点に合わせる。共振の鋭い山ひとつに引きずられないため
  - はみ出した点は、グラフの端に寄せて描く（切り替えられる）
  - 軸を選び直したとき、「自動」ボタン、ダブルクリックで働く。取り直すたびには
    合わせない（見ている場所が勝手に動かないように）
- **log 軸で 0 以下になる値**
  - 描かずに、その数を下の帯に出す（例: 電源の吸収電力は負になる）
- **点の色**
  - 同じ画素に落ちた点の数の log(1+c) で濃淡を付ける

## モデルの書き方

```js
const model = {
  name: '直列 RLC',
  vars: [
    // value が中心。lo, hi を省くと幅 0（固定値）から始まる
    {id:'R', label:'R', unit:'Ω',  value:10,   dist:'log', min:0.1, max:1e3},
    {id:'f', label:'f', unit:'Hz', value:50e3, dist:'log', lo:10e3, hi:200e3},
  ],
  outs: [
    {id:'P', label:'P(R)', unit:'W', scale:'log'},   // scale は軸に選んだときの既定
  ],
  eval(x, y){          // x: Float64Array(n) を読み、y: Float64Array(m) に全部書く
    y[0] = …;
  },
};
RandomPlot2D.mount(document.getElementById('app'), model, {n: 200000, x:{col:'f'}, y:{col:'P'}});
```

| 変数の項目 | |
|---|---|
| `id` | 必須。変数と関数を通して一意 |
| `value` | 必須。中心の値 |
| `dist` | `'lin'`（既定）か `'log'`。log なら乱数は桁の上で一様、幅も ±桁で数える |
| `min`, `max` | 区間が出てはいけない範囲。両方あるとつまみの帯が出る |
| `lo`, `hi` | 初めの区間。省けば `value` に固定 |
| `step` | ホイール1刻み。log なら桁（既定 0.02）、lin なら値 |

**1回の `eval` で全部の関数値を出す**形にしてある。WPT では1点を解くと
全素子の電力がまとめて出てくるので、m 個の関数を別々に呼ぶ形にすると
同じ計算を m 回することになる。効率 η や正規化電力のように、関数値から
導く量も出力の列の1つとして出せばよい。

`mount` が返すものは `recompute()`、`autoscale()`、`destroy()` と、
`state`（状態）・`data`（いま描いている2列）。

### Go から焼き込む

```go
import randomplot2d "github.com/ichijohodaka/random-plot2d"

page, err := randomplot2d.Page(modelJS, randomplot2d.Options{
	Title: "SSSP2",
	X:     &randomplot2d.Axis{Col: "f", Scale: "log", Link: true},
	Y:     &randomplot2d.Axis{Col: "P_RL"},
})
```

`modelJS` は `const model = {…}` を定義する JavaScript。できた HTML は
外部ファイルを読まない。`randomplot2d.JS`・`randomplot2d.CSS` を直に
使ってもよい。

## WPT に当てはめるとき

wptac の `at(p, w, out)` の包みを1枚書けば済む見込み。

- `vars`: 素子値・結合係数・周波数。`.asc` の値を `value` にする。
  `.ac` の範囲は周波数の `lo`, `hi` にする
- `outs`: 各素子の P、|V|、|I|、η、PN
- `eval(x, y)`: x を `setParam` で p に流し込み、`precompute(p)` →
  `at(p, 2πf, out)` → out から y を詰める

`precompute` は素子値が変わらなければ省けるが、乱数で振っている間は点ごとに
変わるので、ここでは毎回呼ぶ（省く工夫はモデルの内側でできる）。

## 検算

```powershell
node --test test/
go test ./...
```

- 区間の中に入ること、固定値がそのままであること
- 対数一様なら中点（桁の上）の下にちょうど半分入ること
- 関数値の列が `eval` を直に呼んだものと同じであること
- 同じ種なら同じ標本、**別の変数の区間を変えても自分の標本は変わらない**こと
- 少しずつ進めても一度に計算しても、ビット単位で同じであること
- 関数値を使わない軸の組み合わせでは `eval` を呼ばないこと
- 分位点で決めた範囲が、外れ値ひとつに引きずられないこと
- 焼き込んだ HTML の script が Node で読めること、外部ファイルを読まないこと

## 構成

```
web/random-plot2d.js   UI と計算の核（ビルド不要。ブラウザでは大域、Node では require）
web/random-plot2d.css  見た目。色は .rp2 の CSS 変数
web/demo-model.js      見本のモデル（直列 RLC）
demo.html              見本のページ（web/ を読む）
page.go                go:embed で JS・CSS を持ち、1枚の HTML にまとめる
cmd/rp2page/           モデルの JS から1枚の HTML を作る
test/                  計算の核の試験（node --test）
```

## 記録

| | |
|---|---|
| [20260926.md](20260926.md) | 依頼 |
| [20260926-design-options.md](20260926-design-options.md) | 設計の選択肢と選んだ案 |
