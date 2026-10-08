"""Survey uploaded PDFs before touching their content.

Reports, per file: pages, whether it carries an /Encrypt dictionary and what the
permission bits allow, whether a text layer exists at all (a scan has none), and
any copyright or distribution notice found in that text. Nothing is extracted
here; this only decides what may be extracted.
"""
import sys, os, re, json
from pypdf import PdfReader

NOTICE = re.compile(
    r"(may not be (taught|copied|reproduced|distributed)"
    r"|all rights reserved"
    r"|copyright|\(c\)\s*\d{4}|©"
    r"|כל הזכויות שמורות|אין להעתיק|זכויות יוצרים|אין לשכפל|אין להפיץ)",
    re.I)

def survey(path):
    out = {"file": os.path.basename(path), "kb": round(os.path.getsize(path)/1024)}
    try:
        r = PdfReader(path)
    except Exception as e:
        out["error"] = str(e)[:120]
        return out
    out["encrypted"] = bool(getattr(r, "is_encrypted", False))
    if out["encrypted"]:
        try:
            r.decrypt("")
            out["decrypt"] = "empty-password"
        except Exception as e:
            out["decrypt"] = "failed: " + str(e)[:60]
    try:
        out["pages"] = len(r.pages)
    except Exception as e:
        out["pages"] = "?"
        out["error"] = str(e)[:120]
        return out
    try:
        perms = r.user_access_permissions
        if perms is not None:
            out["can_extract"] = bool(getattr(perms, "extract", True))
            out["can_print"] = bool(getattr(perms, "print", True))
    except Exception:
        pass

    chars, notices = 0, set()
    sample = []
    for i, page in enumerate(r.pages):
        try:
            t = page.extract_text() or ""
        except Exception:
            t = ""
        chars += len(t.strip())
        for m in NOTICE.finditer(t):
            notices.add(m.group(0).strip()[:60])
        if i < 2 and t.strip():
            sample.append(re.sub(r"\s+", " ", t.strip())[:220])
    out["text_chars"] = chars
    out["kind"] = "text" if chars > 200 else ("scan" if chars < 40 else "thin")
    out["notices"] = sorted(notices)
    out["head"] = sample[:1]
    return out

if __name__ == "__main__":
    print(json.dumps([survey(p) for p in sys.argv[1:]], ensure_ascii=False, indent=1))
