; Language injections for Orbit.
;
; Orbit injects far less than a typical template language, and that is a
; deliberate consequence of the design rather than an omission:
;
;   * There is no CSS injection, because `<style>` is not in the element
;     allowlist and the `style=` attribute may only hold static text (the
;     engine rejects interpolation there at parse time). There is no context in
;     which a highlighter would encounter dynamic CSS.
;
;   * There is no JavaScript injection, because `<script>` is banned and `on*`
;     attributes are rejected. Orbit templates cannot contain script at all —
;     this is the property that makes RAWTEXT unreachable by construction.
;
; What remains is JSON: `<json-ld>` wraps a single record expression that the
; engine serializes as JSON-LD. It is Orbit expression syntax rather than
; literal JSON, so injecting `json` would mis-highlight identifiers and pipes.
; It is left to the expression rules above, which already handle it correctly.
;
; This file exists to make that reasoning explicit — an empty injections file
; reads as "nobody got to it yet", which is the wrong conclusion here.
