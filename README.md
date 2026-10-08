# Bbabbi Soul

A small soulslike action game in the browser: an 8-direction pixel-sprite knight and his papillon
walk a low-poly forest where goblins hide in the bushes.

**Play:** https://jooooohn86.github.io/bbabbi-soul/

## Controls

| Key | Action |
|---|---|
| WASD | Move |
| Mouse | Turn the camera (the cursor locks to the game on the first click; Esc frees it) |
| Right click / J | Attack |
| Left click (hold) / K | Shield guard |
| Space | Roll (invincible mid-roll) |
| Shift | Sprint (uses stamina) |
| Wheel | Zoom |
| Q / E | Turn the camera (keyboard) |
| F | Wireframe view |

Kill goblins for points (small 1, medium 2, large 3). When you die, spend them on attack, defence or
stamina, then continue, or wipe everything and start over. Progress is saved in your browser.

## How it is made

The world is a low-poly Blender scene rendered with Three.js at a low resolution and scaled up with
nearest-neighbour filtering. Every character is a 3D model in Blender rendered from 8 directions into
sprite sheets; in the game each one is a single flat sprite that turns to face the camera and shows
the view that matches its facing.
