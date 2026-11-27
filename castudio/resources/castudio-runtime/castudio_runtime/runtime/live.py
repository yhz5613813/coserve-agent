"""The product of a notebook running in an editor's marimo kernel.

Headless, :func:`~.runner.run_notebook` runs the cells and projects the
product.  In the editor marimo runs them, reactively, and keeps their
values in the kernel; :func:`live_package` projects the product from
those.  Same executor, same projection, same package: a notebook gives the
same product wherever it runs.

The editor's bridge calls :func:`publish_live` from a snippet it executes
in the kernel once the cells have settled.
"""

from __future__ import annotations

import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from ..product.packages import build_product_package, encode_product_package
from ..scene.preview import PreviewScene, compile_preview, encode_preview, entity_info
from ._marimo import safe_get_context
from .cells import NotebookCells
from .config import read_notebook_config
from .executor import finish_kernel_cache
from .projection import Product, find_product, project_product

PACKAGE_MEDIA_TYPE = "application/vnd.castudio.scadpkg"
PREVIEW_MEDIA_TYPE = "application/vnd.castudio.preview"
# The editor that receives the posts is on 127.0.0.1; never route it through
# http_proxy or the Windows registry system proxy.
_LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class LiveUnavailableError(RuntimeError):
    """No CAStudio notebook is running in this kernel."""


@dataclass(frozen=True)
class LivePackage:
    data: bytes
    """The scene package (a ``cadflow-1.0`` scene ZIP)."""
    definition_id: str
    definition_kind: str
    content_hash: str


def _product_id(product: Product) -> str:
    return product.part_id if hasattr(product, "part_id") else product.assembly_id


def _product_kind(product: Product) -> str:
    return "part" if hasattr(product, "part_id") else "assembly"


def live_package(*, validate: bool = False) -> LivePackage:
    """Project the running notebook's product and package it.

    Call from inside the marimo kernel.  Raises :class:`LiveUnavailableError`
    outside one, and :class:`~.projection.ProductNotFoundError` while no
    cell has produced the product yet (or a cell failed).  ``validate``
    runs the package's contract validation; the live path skips it.
    """

    context = safe_get_context()
    if context is None or context.filename is None:
        raise LiveUnavailableError("not running inside a marimo kernel")
    config = read_notebook_config(context.filename)
    if config is None:
        raise LiveUnavailableError(
            f"{context.filename}: not a CAStudio notebook (no [tool.castudio])"
        )
    finish_kernel_cache(config)  # let the cache finish pickling before we read values
    glbls = context.globals
    ordered = list(context.graph.cells.values())
    cells = NotebookCells(config.path, ordered)
    values = {
        name: glbls[name] for cell in ordered for name in cell.defs if name in glbls
    }
    read = frozenset().union(*(cell.refs for cell in ordered))
    product = project_product(
        find_product(config, values, read),
        config=config,
        cells=cells,
        values=values.values(),
    )
    package = build_product_package(product, validate=validate)
    data = encode_product_package(package)
    return LivePackage(
        data=data,
        definition_id=_product_id(product),
        definition_kind=_product_kind(product),
        content_hash="",
    )


_last_preview: PreviewScene | None = None
"""The scene last previewed in this kernel: what :func:`preview_entity_info` answers about."""


def live_preview() -> tuple[bytes, PreviewScene]:
    """The preview of the running notebook's product, from the values in the kernel.

    Unlike :func:`live_package` this does not project the product: it looks
    at the solids as they are (see :mod:`castudio_runtime.scene.preview`).
    """

    global _last_preview
    context = safe_get_context()
    if context is None or context.filename is None:
        raise LiveUnavailableError("not running inside a marimo kernel")
    config = read_notebook_config(context.filename)
    if config is None:
        raise LiveUnavailableError(
            f"{context.filename}: not a CAStudio notebook (no [tool.castudio])"
        )
    glbls = context.globals
    ordered = list(context.graph.cells.values())
    values = {name: glbls[name] for cell in ordered for name in cell.defs if name in glbls}
    read = frozenset().union(*(cell.refs for cell in ordered))
    scene = compile_preview(find_product(config, values, read))
    _last_preview = scene
    return encode_preview(scene), scene


def publish_preview(url: str, *, step: str = "", timeout: float = 60.0) -> dict[str, Any]:
    """:func:`live_preview`, then POST the bytes to *url*; returns a short summary."""

    data, scene = live_preview()
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": PREVIEW_MEDIA_TYPE, "X-Live-Step": step},
        method="POST",
    )
    try:
        with _LOCAL.open(request, timeout=timeout) as response:
            response.read()
    except (urllib.error.URLError, OSError) as error:
        raise RuntimeError(f"publishing the preview to {url} failed: {error}") from error
    return {"nodes": len(scene.nodes), "parts": len(scene.parts), "bytes": len(data)}


def preview_entity_info(entity_id: str) -> dict[str, Any] | None:
    """The properties of one entity of the scene last previewed (see :func:`entity_info`)."""

    if _last_preview is None:
        return None
    return entity_info(_last_preview, entity_id)


def publish_live(url: str, *, step: str = "", timeout: float = 60.0) -> LivePackage:
    """:func:`live_package`, then POST the package bytes to *url*."""

    package = live_package()
    request = urllib.request.Request(
        url,
        data=package.data,
        headers={"Content-Type": PACKAGE_MEDIA_TYPE, "X-Live-Step": step},
        method="POST",
    )
    try:
        with _LOCAL.open(request, timeout=timeout) as response:
            response.read()
    except (urllib.error.URLError, OSError) as error:
        raise RuntimeError(f"publishing the package to {url} failed: {error}") from error
    return package


__all__ = [
    "LivePackage",
    "LiveUnavailableError",
    "live_package",
    "live_preview",
    "preview_entity_info",
    "publish_live",
    "publish_preview",
]
