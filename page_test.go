package randomplot2d

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestPageBakesEverything(t *testing.T) {
	page, err := Page(DemoModel, Options{Title: "<RLC>", N: 1000, X: &Axis{Col: "f", Scale: "log"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"<title>&lt;RLC&gt;</title>",
		"RandomPlot2D.mount(",
		`"n":1000`,
		`"x":{"col":"f","scale":"log"}`,
		"--rp2-ramp",
		"const model",
	} {
		if !strings.Contains(page, want) {
			t.Errorf("ページに %q がありません", want)
		}
	}
	// 外部ファイルを読まないこと
	if regexp.MustCompile(`<script[^>]+src=|<link[^>]+href=`).MatchString(page) {
		t.Error("外部ファイルを読んでいます")
	}
}

func TestPageRejectsScriptClose(t *testing.T) {
	if _, err := Page("const model = {}; // </SCRIPT>", Options{}); err == nil {
		t.Error("</script を含むモデルを通してしまった")
	}
}

func TestPageOptionsAreEscaped(t *testing.T) {
	page, err := Page(DemoModel, Options{Title: "</script><b>"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(strings.ToLower(page), "</script") != 2 {
		t.Error("題の </script が逃がされていない")
	}
}

// 焼き込んだ script が JavaScript として読めることを Node で確かめる。
func TestPageScriptsParse(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node がありません")
	}
	page, err := Page(DemoModel, Options{})
	if err != nil {
		t.Fatal(err)
	}
	scripts := regexp.MustCompile(`(?s)<script>\n(.*?)</script>`).FindAllStringSubmatch(page, -1)
	if len(scripts) != 2 {
		t.Fatalf("script が %d 個（2 個のはず）", len(scripts))
	}
	dir := t.TempDir()
	for i, s := range scripts {
		p := filepath.Join(dir, "s"+string(rune('0'+i))+".js")
		if err := os.WriteFile(p, []byte(s[1]), 0o644); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command(node, "--check", p).CombinedOutput(); err != nil {
			t.Errorf("script %d が読めない: %v\n%s", i, err, out)
		}
	}
}
