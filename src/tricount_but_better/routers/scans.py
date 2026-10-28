"""The signed-in user's background scans: what is still being read, and what is ready.

Scans start under their team (``POST /teams/{id}/receipts/jobs``,
``POST /teams/{id}/prices/scan/jobs``); these routes follow them wherever the
user went in the meantime. Only the person who started a scan sees it.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import select

from ..deps import CurrentUser, DbSession
from ..models import TeamMember
from ..scan_jobs import jobs
from ..schemas import ScanJobDetailOut, ScanJobOut
from .receipts import job_out

router = APIRouter(prefix="/scans", tags=["receipts"])

# The jobs are run by the event loop, so these routes are async too: on the
# thread pool they would read the jobs while the loop changes them.


@router.get("", response_model=list[ScanJobOut])
async def list_scans(user: CurrentUser) -> list[ScanJobOut]:
    """Oldest first, without what they read: cheap enough to poll."""
    return [job_out(job) for job in jobs.mine(user.id)]


@router.get("/{job_id}", response_model=ScanJobDetailOut)
async def get_scan(job_id: uuid.UUID, user: CurrentUser, session: DbSession) -> ScanJobDetailOut:
    job = jobs.get(user.id, job_id)
    # Lines matched to a team's goods are that team's to see; someone who has
    # left it since starting the scan no longer is.
    if job is None or not session.scalar(
        select(TeamMember.id).where(
            TeamMember.team_id == job.team_id, TeamMember.user_id == user.id
        )
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "scan not found")
    return ScanJobDetailOut(**job_out(job).model_dump(), result=job.result)


@router.delete("/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
async def discard_scan(job_id: uuid.UUID, user: CurrentUser) -> Response:
    """Picked up, or no longer wanted: forget it, and stop reading if it still is."""
    if not jobs.discard(user.id, job_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "scan not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
