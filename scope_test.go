package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The scope battery, as a CI gate. Two questions, both judged by outcome
// rather than by error code: did any byte of an out-of-scope file reach the
// client, and did anything outside the grant change.
//
// The canary content is checked against every reply whatever its shape — a
// refusal that quotes the secret is still a leak.

const (
	exfilCanary = "EXFIL-CANARY-7f3a91c2"
	nameCanary  = "EXFILNAME-9c2af41b.txt" // never sent; seeing it back means enumeration
)

func buildFsmcp(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "fsmcp")
	out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput()
	if err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	return bin
}

// scopeFixture builds a grant with every escape vector in it, plus an
// out-of-scope tree holding the canaries and a credential-shaped file.
func scopeFixture(t *testing.T) (grant, outside string) {
	t.Helper()
	base := t.TempDir()
	grant = filepath.Join(base, "grant")
	outside = filepath.Join(base, "outside")
	for _, d := range []string{grant, filepath.Join(grant, "notes"), filepath.Join(outside, "sub")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(p, s string) {
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(outside, "secret.txt"), exfilCanary+"\n")
	write(filepath.Join(outside, nameCanary), "its name is the secret\n")
	write(filepath.Join(outside, "passwd"), "root:x:0:0:root:/root:/bin/sh\n")
	write(filepath.Join(outside, "sub", "deep.txt"), exfilCanary+"-DEEP\n")
	write(filepath.Join(grant, "notes", "ok.txt"), "in scope\n")

	os.Symlink(outside, filepath.Join(grant, "out_link"))
	os.Symlink("..", filepath.Join(grant, "parent_link"))
	os.Symlink(filepath.Join(outside, "passwd"), filepath.Join(grant, "passwd_link"))
	os.Symlink(filepath.Join(outside, "nope"), filepath.Join(grant, "dangling_link"))
	return grant, outside
}

func treeState(t *testing.T, root string) map[string]string {
	t.Helper()
	state := map[string]string{}
	filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			state[p] = "dir"
			return nil
		}
		b, rerr := os.ReadFile(p)
		if rerr != nil {
			state[p] = "unreadable"
			return nil
		}
		sum := sha256.Sum256(b)
		fi, _ := d.Info()
		state[p] = fmt.Sprintf("%s/%o", hex.EncodeToString(sum[:]), fi.Mode().Perm())
		return nil
	})
	return state
}

func callFsmcp(t *testing.T, bin, root, tool string, args map[string]any) string {
	t.Helper()
	enc, _ := json.Marshal(args)
	in := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		fmt.Sprintf(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":%q,"arguments":%s}}`, tool, enc),
	}, "\n") + "\n"
	cmd := exec.Command(bin, "--root", root)
	cmd.Stdin = strings.NewReader(in)
	out, _ := cmd.CombinedOutput()
	return string(out)
}

func TestScopeNoExfiltrationOrDestruction(t *testing.T) {
	bin := buildFsmcp(t)
	grant, outside := scopeFixture(t)
	before := treeState(t, outside)

	escapes := []string{
		filepath.Join(outside, "secret.txt"), // absolute
		"../outside/secret.txt",
		"notes/../../outside/secret.txt",
		"./../outside/secret.txt",
		"../outside//secret.txt",
		"../outside/./secret.txt",
		"out_link/secret.txt",
		"parent_link/outside/secret.txt",
		"passwd_link",
		"../outside/passwd",
		strings.Repeat("../", 12) + "etc/passwd",
	}

	var calls []struct {
		tool string
		args map[string]any
	}
	add := func(tool string, args map[string]any) {
		calls = append(calls, struct {
			tool string
			args map[string]any
		}{tool, args})
	}
	for _, p := range escapes {
		add("fs_read", map[string]any{"path": p})
		add("fs_stat", map[string]any{"path": p})
		add("fs_list", map[string]any{"path": filepath.Dir(p)})
		add("fs_delete", map[string]any{"path": p, "recursive": true})
		add("fs_write", map[string]any{"path": p, "content": "CLOBBERED", "if_sha256": nil})
		add("fs_mkdir", map[string]any{"path": p + "/made"})
		add("fs_move", map[string]any{"source": "notes/ok.txt", "destination": p})
		add("fs_move", map[string]any{"source": p, "destination": "stolen.txt"})
		add("fs_replace", map[string]any{"path": p, "if_sha256": nil,
			"edits": []map[string]any{{"find": "root", "replace": "PWNED"}}})
	}
	// Writing through a symlink that leaves the grant, dangling included: a
	// write through a dangling link creates the target where it points.
	for _, l := range []string{"out_link/pwned", "parent_link/pwned.txt", "dangling_link"} {
		add("fs_write", map[string]any{"path": l, "content": "PWNED", "if_sha256": nil})
		add("fs_delete", map[string]any{"path": l, "recursive": true})
	}
	add("fs_grep", map[string]any{"pattern": "EXFIL-CANARY"})
	add("fs_grep", map[string]any{"pattern": "EXFIL", "path": ".."})
	add("fs_grep", map[string]any{"pattern": "EXFIL", "path": "out_link"})
	add("fs_glob", map[string]any{"pattern": "../**"})
	add("fs_glob", map[string]any{"pattern": "**/../**/secret.txt"})
	add("fs_glob", map[string]any{"pattern": "{../outside,notes}/*"})

	for _, c := range calls {
		reply := callFsmcp(t, bin, grant, c.tool, c.args)
		if strings.Contains(reply, exfilCanary) {
			t.Errorf("EXFILTRATION via %s %v:\n%s", c.tool, c.args, reply)
		}
		if strings.Contains(reply, nameCanary) {
			t.Errorf("ENUMERATION via %s %v: leaked an out-of-scope filename\n%s", c.tool, c.args, reply)
		}
	}

	// The real overwrite shape: stat for the precondition, then write with it.
	// if_sha256:null can never replace an existing file — it means "must not
	// exist" — so a battery using only null never exercises this path at all.
	for _, target := range []string{"../outside/passwd", "passwd_link", "out_link/passwd"} {
		var payload struct {
			SHA256 string `json:"sha256"`
		}
		reply := callFsmcp(t, bin, grant, "fs_stat", map[string]any{"path": target})
		if lines := strings.Split(strings.TrimSpace(reply), "\n"); len(lines) > 0 {
			var env struct {
				Result struct {
					Content []struct{ Text string } `json:"content"`
				} `json:"result"`
			}
			if json.Unmarshal([]byte(lines[len(lines)-1]), &env) == nil && len(env.Result.Content) > 0 {
				json.Unmarshal([]byte(env.Result.Content[0].Text), &payload)
			}
		}
		var pre any
		if payload.SHA256 != "" {
			pre = payload.SHA256
		}
		callFsmcp(t, bin, grant, "fs_write", map[string]any{
			"path": target, "content": "root:x:0:0:PWNED:/root:/bin/sh\n", "if_sha256": pre})
	}

	after := treeState(t, outside)
	for k, v := range before {
		if after[k] != v {
			t.Errorf("DESTRUCTION: %s changed %q -> %q", k, v, after[k])
		}
	}
	for k := range after {
		if _, ok := before[k]; !ok {
			t.Errorf("DESTRUCTION: %s was created outside the grant", k)
		}
	}
}
