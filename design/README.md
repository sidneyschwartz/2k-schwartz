# Design — NBA 2K Blacktop-style 1v1 Basketball

Produced by a 19-agent design team (8 specialist pillars, each adversarially critiqued, then synthesized).

## Master documents
- [Game Design Document](./GDD.md) — vision, core loop, controls, systems, art, audio, tuning
- [Technical Design Document](./TDD.md) — module decomposition, game-state, physics, host-authoritative netcode, server protocol, integration edits
- [Production Roadmap](./ROADMAP.md) — incremental milestones, done-criteria, tests, risk register

## Pillar designs (with critiques)
- [Game Design & Core Loop](./pillars/01-gameplay.md)
- [Rules & Match-Flow](./pillars/02-rules.md)
- [Avatars, Animation & Feel](./pillars/03-avatars.md)
- [Court & Visual Direction](./pillars/04-court.md)
- [Technical Architecture](./pillars/05-architecture.md)
- [Netcode & Multiplayer](./pillars/06-netcode.md)
- [UI/UX & Presentation](./pillars/07-uiux.md)
- [Audio Design](./pillars/08-audio.md)

## Fixed product decisions
- Full 3D (Three.js), reusing golf rendering patterns
- Online multiplayer (two humans over the WebSocket server, host-authoritative)
- Sim-lite / NBA-2K-ish feel: dribble, shot meter, contests, fouls, stamina
- Streetball 1s & 2s, first to 11 win by 2, half-court, check-ball, make-it-take-it, take-it-back
