import json
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware


app = FastAPI(title="HEX Mesh Signaling")

allowed_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@dataclass
class User:
    id: str
    name: str
    websocket: WebSocket

    def to_dict(self) -> Dict[str, str]:
        return {"id": self.id, "name": self.name}


class Manager:
    def __init__(self) -> None:
        self.users: Dict[str, User] = {}

    async def connect(self, websocket: WebSocket, user_id: Optional[str], username: Optional[str]) -> str:
        await websocket.accept()
        safe_id = (user_id or "").strip() or str(uuid.uuid4())
        safe_name = (username or "").strip() or f"user-{safe_id[:6]}"
        if safe_id in self.users:
            safe_id = f"{safe_id}-{uuid.uuid4().hex[:6]}"
        self.users[safe_id] = User(id=safe_id, name=safe_name, websocket=websocket)
        return safe_id

    async def disconnect(self, user_id: str) -> None:
        self.users.pop(user_id, None)

    async def send(self, user_id: str, message: Dict[str, Any]) -> None:
        user = self.users.get(user_id)
        if not user:
            return
        await user.websocket.send_json(message)

    async def users_list(self) -> None:
        payload = {"type": "users_list", "users": [u.to_dict() for u in self.users.values()]}
        for uid in list(self.users.keys()):
            try:
                await self.send(uid, payload)
            except Exception:
                await self.disconnect(uid)


manager = Manager()


def build_ice() -> Dict[str, Any]:
    stun_urls = [u.strip() for u in os.getenv("STUN_URLS", "stun:stun.l.google.com:19302").split(",") if u.strip()]
    turn_urls = [u.strip() for u in os.getenv("TURN_URLS", "").split(",") if u.strip()]
    turn_username = os.getenv("TURN_USERNAME", "")
    turn_password = os.getenv("TURN_PASSWORD", "")

    servers: List[Dict[str, Any]] = [{"urls": u} for u in stun_urls]
    if turn_urls and turn_username and turn_password:
        servers.append({"urls": turn_urls, "username": turn_username, "credential": turn_password})

    return {
        "iceServers": servers,
        "iceTransportPolicy": os.getenv("ICE_TRANSPORT_POLICY", "all"),
    }


@app.get("/")
async def root() -> Dict[str, Any]:
    return {
        "ok": True,
        "ws": "/ws?username=<name>&user_id=<optional>",
        "ice": "/ice-config",
    }


@app.get("/ice-config")
async def ice_config() -> Dict[str, Any]:
    return build_ice()


@app.websocket("/ws")
async def ws_endpoint(
    websocket: WebSocket,
    username: Optional[str] = Query(default=None),
    user_id: Optional[str] = Query(default=None),
) -> None:
    session_id: Optional[str] = None
    try:
        session_id = await manager.connect(websocket, user_id=user_id, username=username)
        await manager.send(session_id, {"type": "self_id", "user_id": session_id})
        await manager.users_list()

        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                await manager.send(session_id, {"type": "error", "message": "invalid json"})
                continue

            msg_type = msg.get("type")

            if msg_type == "ping":
                await manager.send(session_id, {"type": "pong", "ts": int(time.time() * 1000)})
                continue

            if msg_type == "change-name":
                new_name = (msg.get("name") or "").strip()
                if new_name:
                    manager.users[session_id].name = new_name
                    await manager.users_list()
                continue

            if msg_type == "chat_message":
                target = msg.get("target")
                payload = {
                    "type": "chat_message",
                    "sender": session_id,
                    "message": msg.get("message", ""),
                    "meta": msg.get("meta", {}),
                    "ts": int(time.time() * 1000),
                }
                if target:
                    await manager.send(target, payload)
                else:
                    for uid in list(manager.users.keys()):
                        if uid != session_id:
                            await manager.send(uid, payload)
                continue

            if msg_type == "signal":
                target = msg.get("target") or msg.get("to")
                data = msg.get("data") if "data" in msg else msg.get("payload")
                if target and data is not None:
                    await manager.send(target, {"type": "signal", "sender": session_id, "data": data})
                else:
                    await manager.send(session_id, {"type": "error", "message": "signal.target and signal.data are required"})
                continue

            await manager.send(session_id, {"type": "error", "message": f"unknown type: {msg_type}"})

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"ws error user={session_id} err={exc}")
    finally:
        if session_id:
            await manager.disconnect(session_id)
            await manager.users_list()

