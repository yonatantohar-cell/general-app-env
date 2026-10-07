"""Stage the cleared PDFs: extract each one's text and name it by the title the
document itself carries, not by the mangled upload filename.

A guide is headed with the sitting it covers ("סתיו24 א1"); a drill sheet is
headed "מנה יומית" and then its Hebrew mnemonic title. Both are read off page 1.
"""
import sys, os, re, json, unicodedata
from pypdf import PdfReader

HEB = re.compile(r"[֐-׿]")

def page1(path):
    r = PdfReader(path)
    return (r.pages[0].extract_text() or ""), len(r.pages)

def title_of(text, pages):
    lines = [re.sub(r"\s+", " ", l).strip() for l in text.splitlines()]
    lines = [l for l in lines if l and set(l) != {"_"}]
    if pages <= 3:                       # a drill sheet
        for i, l in enumerate(lines):
            if l.startswith("מנה יומית"):
                rest = l[len("מנה יומית"):].strip()
                if rest and HEB.search(rest):
                    return rest
                for nxt in lines[i + 1:]:
                    if nxt.startswith("מנה יומית"):
                        continue
                    if HEB.search(nxt) and not re.match(r"^\d", nxt):
                        return nxt
        return ""
    return lines[0] if lines else ""     # a guide

def slug(s):
    s = re.sub(r'[\\/:*?"<>|]', "", s).strip()
    return re.sub(r"\s+", "-", s)

def main(outroot, paths):
    index = []
    seen = {}
    for p in paths:
        text, pages = page1(p)
        t = title_of(text, pages)
        kind = "sheet" if pages <= 3 else "guide"
        name = slug(t) or os.path.basename(p)[:8]
        seen[name] = seen.get(name, 0) + 1
        if seen[name] > 1:
            name = "%s-%d" % (name, seen[name])
        out = os.path.join(outroot, kind + "s", "text", name + ".txt")
        r = PdfReader(p)
        with open(out, "w", encoding="utf-8") as fh:
            for i, page in enumerate(r.pages, 1):
                fh.write("\n===== PAGE %d =====\n" % i)
                fh.write(page.extract_text() or "")
        index.append({"name": name, "kind": kind, "title": t, "pages": pages,
                      "source": os.path.basename(p)})
    print(json.dumps(index, ensure_ascii=False, indent=1))

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
