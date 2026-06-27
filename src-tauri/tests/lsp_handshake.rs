// Live smoke test: prove the LSP client actually talks to rust-analyzer.
// Spawns the real binary, does the Content-Length framed initialize handshake,
// and asserts the server returns capabilities. Ignored by default because it
// requires rust-analyzer on PATH; run with: cargo test --test lsp_handshake -- --ignored

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};

#[test]
#[ignore]
fn rust_analyzer_initialize_handshake() {
    let mut child = Command::new("rust-analyzer")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("failed to spawn rust-analyzer (is it on PATH?)");

    let mut stdin = child.stdin.take().unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());

    let root = std::env::current_dir().unwrap();
    let root_uri = format!("file:///{}", root.display().to_string().replace('\\', "/"));
    let init = format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"processId":null,"rootUri":"{}","capabilities":{{}}}}}}"#,
        root_uri
    );
    let header = format!("Content-Length: {}\r\n\r\n", init.as_bytes().len());
    stdin.write_all(header.as_bytes()).unwrap();
    stdin.write_all(init.as_bytes()).unwrap();
    stdin.flush().unwrap();

    // Read framed messages until we see the response with id == 1.
    let mut found_caps = false;
    for _ in 0..50 {
        let mut content_length = 0usize;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap() == 0 {
                panic!("rust-analyzer closed stdout before responding");
            }
            let t = line.trim_end();
            if t.is_empty() {
                break;
            }
            if let Some(rest) = t.strip_prefix("Content-Length:") {
                content_length = rest.trim().parse().unwrap();
            }
        }
        if content_length == 0 {
            continue;
        }
        let mut body = vec![0u8; content_length];
        reader.read_exact(&mut body).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        if v.get("id").and_then(|x| x.as_i64()) == Some(1) {
            assert!(
                v.get("result").and_then(|r| r.get("capabilities")).is_some(),
                "initialize response missing capabilities: {}",
                v
            );
            found_caps = true;
            break;
        }
    }
    let _ = child.kill();
    assert!(found_caps, "never received initialize response with id 1");
}
