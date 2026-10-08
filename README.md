# Bbabbi Soul

A small soulslike action game in the browser: an 8-direction pixel-sprite knight and his papillon
walk a low-poly forest where goblins hide in the bushes. Past the ridge around it lies the infected
zone: dead trees, toxic pools, glowing crystals and a crowd of zombies.

**Play:** https://jooooohn86.github.io/bbabbi-soul/

## Controls

| Key | Action |
|---|---|
| WASD | Move |
| Left click / J | Attack |
| Right click (hold) / K | Shield guard |
| Pointer at the left / right screen edge | Turn the camera (also middle-button drag, or Q / E) |
| Space | Roll (invincible mid-roll) |
| Shift | Sprint (uses stamina) |
| Wheel | Zoom |
| F | Wireframe view |

Kills give points (goblins: small 0.5, medium 1, large 1.5; zombies 0.5). When you die, spend them on
health, attack, defence or stamina (1 point per level), then continue, or wipe everything and start
over. Progress is saved in your browser.

## How it is made

The world is a low-poly Blender scene rendered with Three.js at a low resolution and scaled up with
nearest-neighbour filtering. Every character is a 3D model in Blender rendered from 8 directions into
sprite sheets; in the game each one is a single flat sprite that turns to face the camera and shows
the view that matches its facing.
