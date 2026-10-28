"""Scans that run in the background, so the app stays usable while a model reads.

A scan takes from seconds to minutes. Rather than hold one request open that
long -- a phone drops it as soon as the screen locks or the camera opens -- the
photos are handed to a job, and the app asks after it. Whoever started a scan
can leave the page and come back to it.

Jobs live in this process's memory and nowhere else: the photos are let go as
soon as the model has read them, and a result nobody picks up is dropped after
``RESULT_TTL``, so a scan is still never written to disk. That needs the API to
run as a single process, as ``deploy/systemd/tricount.service`` does.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel

from .vlm import VlmError

log = logging.getLogger(__name__)

ScanKind = Literal["receipt", "prices"]
ScanStatus = Literal["reading", "done", "failed"]

# How long a finished scan waits to be picked up.
RESULT_TTL = 30 * 60
# Scans one person can have reading at once; each holds its photos in memory.
MAX_READING = 3


class TooManyScans(RuntimeError):
    pass


@dataclass(slots=True, eq=False)
class ScanJob:
    user_id: uuid.UUID
    team_id: uuid.UUID
    kind: ScanKind
    id: uuid.UUID = field(default_factory=uuid.uuid4)
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    status: ScanStatus = "reading"
    result: BaseModel | None = None
    error: str | None = None
    finished: float | None = None  # monotonic
    task: asyncio.Task | None = field(default=None, repr=False)


class ScanJobs:
    def __init__(self) -> None:
        self._jobs: dict[uuid.UUID, ScanJob] = {}

    def start(
        self,
        user_id: uuid.UUID,
        team_id: uuid.UUID,
        kind: ScanKind,
        work: Callable[[], Awaitable[BaseModel]],
    ) -> ScanJob:
        """Run ``work`` in the background. Must be called from the server's event loop."""
        self._expire()
        reading = sum(
            1 for job in self._jobs.values() if job.user_id == user_id and job.status == "reading"
        )
        if reading >= MAX_READING:
            raise TooManyScans(f"at most {MAX_READING} scans can be read at once")
        job = ScanJob(user_id=user_id, team_id=team_id, kind=kind)
        job.task = asyncio.create_task(self._run(job, work), name=f"scan-{job.id}")
        self._jobs[job.id] = job
        return job

    async def _run(self, job: ScanJob, work: Callable[[], Awaitable[BaseModel]]) -> None:
        try:
            job.result = await work()
            job.status = "done"
        except VlmError as exc:
            job.status, job.error = "failed", str(exc)
        except Exception:
            log.exception("scan %s failed", job.id)
            job.status, job.error = "failed", "could not read these images"
        finally:
            job.finished = time.monotonic()
            job.task = None

    def mine(self, user_id: uuid.UUID) -> list[ScanJob]:
        self._expire()
        jobs = [job for job in self._jobs.values() if job.user_id == user_id]
        return sorted(jobs, key=lambda job: job.created_at)

    def get(self, user_id: uuid.UUID, job_id: uuid.UUID) -> ScanJob | None:
        self._expire()
        job = self._jobs.get(job_id)
        return job if job is not None and job.user_id == user_id else None

    def discard(self, user_id: uuid.UUID, job_id: uuid.UUID) -> bool:
        """Forget a scan, stopping it if it is still being read."""
        job = self.get(user_id, job_id)
        if job is None:
            return False
        del self._jobs[job_id]
        if job.task is not None:
            job.task.cancel()
        return True

    async def close(self) -> None:
        tasks = [job.task for job in self._jobs.values() if job.task is not None]
        self._jobs.clear()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def _expire(self) -> None:
        cutoff = time.monotonic() - RESULT_TTL
        stale = [job.id for job in self._jobs.values() if (job.finished or cutoff) < cutoff]
        for job_id in stale:
            del self._jobs[job_id]


jobs = ScanJobs()
