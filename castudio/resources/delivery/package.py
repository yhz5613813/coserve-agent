"""Create a portable ZIP from the server-owned, already verified staging folder."""
import pathlib
import sys
import zipfile


def main():
    root = pathlib.Path(sys.argv[1]).resolve(strict=True)
    target = pathlib.Path(sys.argv[2]).resolve()
    if target.is_relative_to(root):
        raise ValueError("ZIP output must be outside its input directory")
    with zipfile.ZipFile(target, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=5, allowZip64=True) as archive:
        for item in sorted(root.rglob("*")):
            if item.is_symlink():
                raise ValueError("Symbolic links are not supported")
            if item.is_file():
                archive.write(item, item.relative_to(root).as_posix())
    with zipfile.ZipFile(target) as archive:
        broken = archive.testzip()
        if broken:
            raise ValueError("ZIP CRC check failed: " + broken)


if __name__ == "__main__":
    main()
