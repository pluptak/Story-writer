# Bad Story (test fixture)

Every config value below is deliberately malformed, and each one's numeric prefix DIFFERS from the
default it must fall back to — so half-coercion ("99garbage" -> 99) and correct rejection
("99garbage" -> 24) cannot produce the same result. Lives outside stories/, so discoverStories()
never offers it.

## Premise
A fixture. Nothing here is meant to be read as a story; it exists so the loader can be caught
accepting a value it should have rejected.

## Scene
place: Nowhere in particular
length: 12.5

## Characters

### GHOST
file: ghost.md
restrictions: telepathy
skills: walking through walls :: what it says | :: a meaning with no name

## Config
max_steps: 99garbage
retries: 7.5
clarifications: 0
stream: flase
thinking_writer: highh
attempts: -3

## Models
default: not-a-real-model
