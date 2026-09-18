"""Console entry point: run the API server."""

from __future__ import annotations


def main() -> None:
    import uvicorn

    uvicorn.run("tricount_but_better.main:app", host="127.0.0.1", port=8000, reload=True)
