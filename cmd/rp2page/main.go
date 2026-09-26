// rp2page は、モデルを書いた JavaScript から1枚で開ける HTML を作る。
//
//	go run ./cmd/rp2page -o demo-standalone.html            # 見本の直列 RLC
//	go run ./cmd/rp2page -model mymodel.js -o mymodel.html
package main

import (
	"flag"
	"fmt"
	"os"

	randomplot2d "github.com/ichijohodaka/random-plot2d"
)

func main() {
	modelPath := flag.String("model", "", "model を定義する JavaScript（省略すると見本の直列 RLC）")
	out := flag.String("o", "random-plot2d.html", "書き出す HTML")
	title := flag.String("title", "", "ページの題（省略するとモデルの name）")
	n := flag.Int("n", 0, "点数（省略すると 200000）")
	flag.Parse()

	src := randomplot2d.DemoModel
	if *modelPath != "" {
		b, err := os.ReadFile(*modelPath)
		if err != nil {
			fail(err)
		}
		src = string(b)
	}
	page, err := randomplot2d.Page(src, randomplot2d.Options{Title: *title, N: *n})
	if err != nil {
		fail(err)
	}
	if err := os.WriteFile(*out, []byte(page), 0o644); err != nil {
		fail(err)
	}
	fmt.Printf("%s (%d バイト)\n", *out, len(page))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "rp2page:", err)
	os.Exit(1)
}
