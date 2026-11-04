# 美股策略助手「本地 MCP」桥接：基于 mcp-proxy，额外放行 Chrome 私有网络（本机）预检。
# 用法：python tzzb_bridge.py --port 8765 --allow-origin "https://fast.freebacktrack.tech" --expose-header mcp-session-id tzzb-mcp
# 依赖：pip install mcp-proxy
import sys

import starlette.middleware.cors as _cors

_orig_init = _cors.CORSMiddleware.__init__


def _init(self, *args, **kwargs):
    kwargs["allow_private_network"] = True
    _orig_init(self, *args, **kwargs)


_cors.CORSMiddleware.__init__ = _init

from mcp_proxy.__main__ import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
