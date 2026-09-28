"""ComfyUI-Manhattan — column/table layout for the graph canvas.

Purely client-side: WEB_DIRECTORY is the whole extension. Every .js under js/
is auto-loaded by the frontend as an ES module (ComfyUI/server.py:1245 mounts
it, /extensions manifest lists it). No nodes, no routes, no server state — the
pack must import cleanly with no PromptServer.instance, because
tools/make_workflow.py imports every pack headlessly to read node definitions.

The full record lives in docs/grid-cable.md.
"""

WEB_DIRECTORY = "./js"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
