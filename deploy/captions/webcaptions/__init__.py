"""Server-side live captions for Webinar Liv.

A LiveKit agent that joins a room when the API dispatches it (the host turned server
captions on), transcribes the active speakers with faster-whisper, and posts each finished
line to the API, which fans it out exactly like a browser caption. See README.md.

The modules below the agent glue (agent.py) are plain Python with no LiveKit import, so
the parts worth testing — who gets transcribed, when the CPU guard steps in, how Hindi is
romanised, what is posted — run under pytest without a LiveKit server or a model.
"""
