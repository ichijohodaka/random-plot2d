// Package randomplot2d は、web/ にある 2D 散布図の UI を Go から焼き込むための
// 薄い包みである。
//
// UI そのものは JavaScript（web/random-plot2d.js）で、ビルドは要らない。
// このパッケージは、それと応用側のモデル（JavaScript）を1枚の HTML に
// まとめるだけを受け持つ。できた HTML は外部ファイルを読まないので、
// ダブルクリックで開ける。
package randomplot2d

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"html"
	"strings"
)

// JS は UI と計算の核。読み込むと大域に RandomPlot2D が置かれる。
//
//go:embed web/random-plot2d.js
var JS string

// CSS は UI の見た目。色は .rp2 の CSS 変数で差し替えられる。
//
//go:embed web/random-plot2d.css
var CSS string

// DemoModel は見本のモデル（直列 RLC）。model という名前の定数を定義する。
//
//go:embed web/demo-model.js
var DemoModel string

// Axis は軸の初期設定。Col は変数か関数の id。
type Axis struct {
	Col   string `json:"col,omitempty"`
	Scale string `json:"scale,omitempty"` // "lin" | "log"。空ならモデルの既定
	Link  bool   `json:"link,omitempty"`  // 変数の乱数の区間を表示範囲に合わせる
}

// Options は RandomPlot2D.mount に渡す設定。空の項目はモデルと UI の既定に従う。
type Options struct {
	Title string  `json:"title,omitempty"`
	N     int     `json:"n,omitempty"`
	Seed  uint32  `json:"seed,omitempty"`
	X     *Axis   `json:"x,omitempty"`
	Y     *Axis   `json:"y,omitempty"`
	Gamma float64 `json:"gamma,omitempty"`
}

// Page は、modelJS をモデルとして描く1枚の HTML を返す。
//
// modelJS は model という名前の値（const model = {vars, outs, eval}）を
// 定義する JavaScript でなければならない。インライン script に埋めるので、
// "</script" を含んではならない。
func Page(modelJS string, opt Options) (string, error) {
	if hasScriptClose(modelJS) {
		return "", fmt.Errorf("randomplot2d: modelJS に </script が含まれています")
	}
	if hasScriptClose(JS) {
		return "", fmt.Errorf("randomplot2d: 埋め込みの JS に </script が含まれています")
	}
	o, err := json.Marshal(opt) // < > & は < などに逃がされる
	if err != nil {
		return "", err
	}
	title := opt.Title
	if title == "" {
		title = "random-plot2d"
	}

	var b strings.Builder
	b.WriteString("<!doctype html>\n<html lang=\"ja\">\n<head>\n<meta charset=\"utf-8\">\n")
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n")
	fmt.Fprintf(&b, "<title>%s</title>\n", html.EscapeString(title))
	b.WriteString("<style>\n")
	b.WriteString(strings.ReplaceAll(CSS, "</style", "<\\/style"))
	b.WriteString("\nhtml, body { height: 100%; margin: 0; } #app { height: 100%; }\n</style>\n")
	b.WriteString("</head>\n<body>\n<div id=\"app\"></div>\n<script>\n")
	b.WriteString(JS)
	b.WriteString("\n</script>\n<script>\n")
	b.WriteString(modelJS)
	if opt.Title == "" {
		b.WriteString("\n;if (model.name) document.title = model.name;")
	}
	fmt.Fprintf(&b, "\n;RandomPlot2D.mount(document.getElementById('app'), model, %s);\n", o)
	b.WriteString("</script>\n</body>\n</html>\n")
	return b.String(), nil
}

func hasScriptClose(s string) bool {
	return strings.Contains(strings.ToLower(s), "</script")
}
