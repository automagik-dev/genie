//! T2: the mirror in `src/lib.rs` equals the frozen, normalized copy of Unfold's declarations in
//! `tests/fixtures/rth-tools-part.txt`. It proves the mirror still equals that copy, never that
//! Unfold has not moved; the README's re-pin step refreshes the copy.

use std::fs;
use std::path::Path;

use sha2::{Digest, Sha256};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/rth-tools-part.txt");
const MIRROR: &str = include_str!("../src/lib.rs");
/// The source the fixture was taken from, relative to the rth checkout.
const UNFOLD_CRATE: &str = "bench/staging/agentd-rc5.13.3/ws/crates/rth-tools";
const SOURCES: [&str; 3] = ["src/parts.rs", "src/authority.rs", "src/profile.rs"];
/// Every mirrored declaration, by the Unfold file that declares it.
const ITEMS: [(&str, &str); 6] = [
    ("src/parts.rs", "PartOutput"),
    ("src/parts.rs", "Part"),
    ("src/authority.rs", "SCHEMA"),
    ("src/authority.rs", "PartTool"),
    ("src/authority.rs", "PartManifest"),
    ("src/profile.rs", "Effect"),
];

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Whitespace and trailing commas are formatting, not contract: keep one space only between two
/// identifier characters and drop a comma that closes a list.
fn normalize(text: &str) -> String {
    let ident = |c: char| c.is_alphanumeric() || c == '_' || c == '\'' || c == '"';
    let mut out = String::new();
    let mut gap = false;
    for c in text.chars() {
        if c.is_whitespace() {
            gap = true;
            continue;
        }
        if gap && out.chars().last().is_some_and(ident) && ident(c) {
            out.push(' ');
        }
        gap = false;
        if matches!(c, ')' | '}' | '>' | ']') && out.ends_with(',') {
            out.pop();
        }
        out.push(c);
    }
    out
}

/// The declaration of `name` in `source`, with its attributes and without comments, normalized.
fn extract(source: &str, name: &str) -> Option<String> {
    let lines: Vec<&str> = source.lines().collect();
    let starts = |l: &str| {
        let t = l.trim_start();
        ["pub struct ", "pub enum ", "pub trait ", "pub const "].iter().any(|kw| {
            t.strip_prefix(kw)
                .and_then(|rest| rest.strip_prefix(name))
                .is_some_and(|rest| rest.starts_with([' ', ':', '{', '<', ';']))
        })
    };
    let at = lines.iter().position(|l| starts(l))?;
    let mut first = at;
    while first > 0 {
        let t = lines[first - 1].trim_start();
        if t.starts_with("#[") || t.starts_with("///") {
            first -= 1;
        } else {
            break;
        }
    }
    let mut kept = Vec::new();
    let mut depth = 0i32;
    for (i, line) in lines.iter().enumerate().skip(first) {
        let t = line.trim();
        if t.starts_with("//") {
            continue;
        }
        kept.push(t);
        if i >= at {
            depth += t.matches('{').count() as i32 - t.matches('}').count() as i32;
            if depth == 0 && (t.ends_with('}') || t.ends_with(';')) {
                break;
            }
        }
    }
    Some(normalize(&kept.join(" ")))
}

struct Fixture {
    body_sha256: String,
    items: Vec<(String, String, String)>,
}

fn parse(text: &str) -> Fixture {
    let mut body_sha256 = String::new();
    let mut items = Vec::new();
    for line in text.lines() {
        if let Some(sha) = line.strip_prefix("body sha256=") {
            body_sha256 = sha.to_string();
        } else if let Some(rest) = line.strip_prefix("item ") {
            let mut parts = rest.splitn(3, ' ');
            let (file, name, decl) = (parts.next(), parts.next(), parts.next());
            items.push((file.unwrap().into(), name.unwrap().into(), decl.unwrap_or("").into()));
        }
    }
    Fixture { body_sha256, items }
}

fn body(items: &[(String, String, String)]) -> String {
    items.iter().map(|(f, n, d)| format!("item {f} {n} {d}\n")).collect()
}

/// The re-pin step: rebuild the fixture from an Unfold checkout of `rth-tools`.
fn repin(unfold_crate: &Path) -> String {
    let mut out = String::from(
        "# genie-part parity fixture: Unfold's part declarations, frozen and normalized.\n\
         # Written by the re-pin step in crates/genie-part/README.md; never edit it by hand.\n",
    );
    out.push_str(&format!("unfold {UNFOLD_CRATE}\n"));
    for src in SOURCES {
        let bytes = fs::read(unfold_crate.join(src)).unwrap_or_else(|e| panic!("{src}: {e}"));
        out.push_str(&format!("source {src} sha256={}\n", sha256(&bytes)));
    }
    let items: Vec<(String, String, String)> = ITEMS
        .iter()
        .map(|(src, name)| {
            let text = fs::read_to_string(unfold_crate.join(src)).unwrap();
            let decl = extract(&text, name).unwrap_or_else(|| panic!("{name} is not declared in {src}"));
            (src.to_string(), name.to_string(), decl)
        })
        .collect();
    let body = body(&items);
    out.push_str(&format!("body sha256={}\n", sha256(body.as_bytes())));
    out.push_str(&body);
    out
}

/// Every difference between the fixture and a mirror source, as one line each.
fn drift(fixture: &Fixture, mirror: &str) -> Vec<String> {
    let mut found = Vec::new();
    if sha256(body(&fixture.items).as_bytes()) != fixture.body_sha256 {
        found.push("the fixture body does not match its recorded sha256 (hand-edited?)".into());
    }
    for (src, name) in ITEMS {
        let frozen = fixture.items.iter().find(|(f, n, _)| f == src && n == name).map(|(_, _, d)| d);
        let mine = extract(mirror, name);
        if frozen != mine.as_ref() {
            found.push(format!("{name} ({src}): frozen {frozen:?}, mirror {mine:?}"));
        }
    }
    found
}

#[test]
fn the_mirror_equals_the_frozen_unfold_copy() {
    if let Some(dir) = std::env::var_os("GENIE_PART_REPIN") {
        fs::write(FIXTURE, repin(Path::new(&dir))).unwrap();
    }
    let fixture = parse(&fs::read_to_string(FIXTURE).unwrap());
    assert_eq!(fixture.items.len(), ITEMS.len(), "every mirrored declaration is in the fixture");
    for src in SOURCES {
        let pinned = fs::read_to_string(FIXTURE).unwrap();
        assert!(pinned.contains(&format!("source {src} sha256=")), "the fixture records {src} and its sha256");
    }
    let found = drift(&fixture, MIRROR);
    assert!(found.is_empty(), "the mirror drifted from the frozen copy:\n{}", found.join("\n"));
}

#[test]
fn changing_one_field_on_either_side_fails() {
    let pinned = fs::read_to_string(FIXTURE).unwrap();
    // The mirror side: one renamed field, one changed type, one dropped serde attribute.
    for (from, to) in [
        ("pub title: String,", "pub label: String,"),
        ("pub is_error: bool,", "pub is_error: u8,"),
        ("#[serde(rename_all = \"snake_case\")]", ""),
        ("Irreversible,", "Irreversible, Unknown,"),
    ] {
        assert!(MIRROR.contains(from), "the mutation {from:?} applies");
        let found = drift(&parse(&pinned), &MIRROR.replacen(from, to, 1));
        assert!(!found.is_empty(), "mirror mutation {from:?} -> {to:?} went unnoticed");
    }
    // The frozen side, with its digest recomputed so only the comparison can catch it.
    let mut fixture = parse(&pinned);
    let item = fixture.items.iter_mut().find(|(_, n, _)| n == "PartTool").unwrap();
    item.2 = item.2.replace("pub name:String", "pub name:Option<String>");
    fixture.body_sha256 = sha256(body(&fixture.items).as_bytes());
    assert!(!drift(&fixture, MIRROR).is_empty(), "a changed frozen field went unnoticed");
    // A hand edit that leaves the digest alone is caught by the digest.
    let mut edited = parse(&pinned);
    edited.items[0].2.push(' ');
    assert!(!drift(&edited, MIRROR).is_empty());
}

#[test]
fn the_wire_shape_is_unfolds() {
    use genie_part::{Effect, PartManifest, SCHEMA};
    let json = r#"{"schema":"rth-part/v1","id":"genie.tasks","version":"1","title":"Tasks",
        "tools":[{"name":"forge_sync","effect":"reversible"}]}"#;
    let manifest: PartManifest = serde_json::from_str(json).unwrap();
    assert_eq!(manifest.schema, SCHEMA);
    assert_eq!(manifest.tools[0].effect, Effect::Reversible);
    let back = serde_json::to_string(&manifest.tools[0]).unwrap();
    assert_eq!(back, r#"{"name":"forge_sync","effect":"reversible"}"#, "an absent description is not written");
    let unknown = json.replace(r#""title""#, r#""extra":1,"title""#);
    assert!(serde_json::from_str::<PartManifest>(&unknown).is_err(), "unknown fields are refused");
}
