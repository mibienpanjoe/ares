"""Event sources for ares-watchd.

Each source coroutine takes a shared asyncio.Queue and pushes bus-format
event dicts. The dispatcher applies them to HarnessState and broadcasts
to clients.
"""
