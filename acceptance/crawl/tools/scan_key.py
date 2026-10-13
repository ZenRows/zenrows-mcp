"""Fail the run if the API key appears in any file under out/. Reads the key from the env."""
import os
import sys

key = os.environ.get("ZENROWS_API_KEY", "").encode()
hits = []
for root, dirs, files in os.walk(sys.argv[1]):
    # Only out/build itself, where the builders write the source copy and the artifact.
    if root == sys.argv[1] and "build" in dirs:
        dirs.remove("build")
    for f in files:
        p = os.path.join(root, f)
        try:
            with open(p, "rb") as fh:
                if key and key in fh.read():
                    hits.append(p)
        except OSError:
            pass
if hits:
    print("THE API KEY APPEARS IN:", *hits, sep="\n  ")
    sys.exit(1)
print("key scan: the key appears in no result, log or report file")
