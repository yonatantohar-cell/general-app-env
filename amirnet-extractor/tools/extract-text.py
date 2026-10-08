"""Extract the text layer of a PDF to stdout, page by page.

Used only on files the survey cleared: no /Encrypt, no extraction restriction
and no copyright or distribution notice anywhere in the document.
"""
import sys, re
from pypdf import PdfReader

def main(path, first=None, last=None):
    r = PdfReader(path)
    pages = r.pages[(first or 1) - 1 : (last or len(r.pages))]
    for i, p in enumerate(pages, start=(first or 1)):
        try:
            t = p.extract_text() or ""
        except Exception as e:
            t = "[[extract failed: %s]]" % e
        print("\n===== PAGE %d =====" % i)
        print(t)

if __name__ == "__main__":
    a = sys.argv[1:]
    main(a[0], int(a[1]) if len(a) > 1 else None, int(a[2]) if len(a) > 2 else None)
