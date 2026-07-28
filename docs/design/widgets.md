# Platform widgets

Design report, written before implementation as J4 requires. The four questions
the brief asked are §2 through §5.

Phase D found client interactivity concentrated in 7 blocks — `header`,
`product-grid`, `buy-box`, `product-carousel`, `slideshow`, `social-share`,
`appointment-widget`. Seven out of 116 badly understates it: strip the
vertical-specific ones and what remains is the header, the product grid and the
buy box, on every page of every theme. It is not a long tail. It is the checkout
path.

It is also **one missing mechanism, seven times**: a way for a theme to say *put
the platform's cart drawer here*.

## 0. What this is, and is not

**Not an escape hatch. Not author-written JavaScript.** The settled position is
that Orbit ships JavaScript; what it forbids is a theme author writing it. A
widget is provided and compiled by the platform, placed by the theme, and
configured through typed attributes the checker verifies.

A widget is **not an island** — the two are kept lexically apart on purpose, and
they compose. See [scope.md](../scope.md#two-words-that-are-not-the-same-word).

| | Island | Widget |
|---|---|---|
| A deferred **server fragment** | A **client component** |
| Rendered by the engine, second pass | Rendered in the browser by platform code |
| For caching | For interactivity |
| Shipped | This document |

## 1. Allocation

Per `ORBIT-OPEN-LANGUAGE.md`'s rule, and this is the line that matters:

**orbit-lang defines the mechanism.** How a host registers a widget, how its
attributes are typed and checked, how it participates in the access plan, how
hydration is declared, what happens when it fails to load.

**CommerceOS defines the catalogue.** `<CartDrawer>`, `<VariantPicker>`,
`<SearchBox>`. **None of those names appears in this repository**, and a test
should assert that — the same way nothing here knows what a `Product` is.

This is exactly the seam host filters and `TypeRegistry` already occupy: a typed
registration surface, not a new concept.

## 2. The registration surface

A widget is declared the way a host filter is — a typed declaration validated at
embed time, with a programming-error throw rather than a template diagnostic.

```ts
export interface WidgetDecl {
  /** PascalCase, and must not collide with a template component name. */
  name: string;

  /** Typed attributes, checked at every placement. Same Type vocabulary. */
  props: Record<string, Type>;

  /** Props without a default are required at the call site. */
  defaults?: Record<string, unknown>;

  /**
   * When this widget becomes interactive. Host-declared, because the compiler
   * cannot infer for code it did not compile — see §3.
   */
  hydrate: 'load' | 'idle' | 'visible' | 'media';
  media?: string;

  /** What the server renders in its place. See §4. */
  fallback: 'empty' | 'children';

  /** The client bundle, pinned by major. See §5. */
  module: string;
  version: string;
}
```

Placement reuses component-call syntax, because a widget *is* a component from
the theme's point of view and inventing a second call syntax would be ceremony:

```text
{# PROPOSED — this syntax does not exist yet, which is why the fence is not
   `orbit`: every `orbit` block in these docs is compiled by the test suite, and
   a proposal that compiled would mean it had already shipped. #}
<CartDrawer open-on="cart:add" label="Your bag">
  <p class="skeleton">Loading your bag…</p>
</CartDrawer>
```

The engine emits a placeholder carrying the resolved props, and the runtime
mounts the widget into it. **The children are the fallback**, exactly as with a
deferred island, and for the same reason: they are what the page shows when the
second thing never happens.

### What the checker enforces

Reusing the rules that already exist rather than inventing parallel ones:

- Every attribute is checked against its declared `Type`. Unknown attribute,
  wrong type, missing required — the same three diagnostics component props
  already have.
- **No `Html` prop.** Same rule and same reason as a deferred island (`O2112`):
  an `Html` value carries its trust obligation in the value, and serializing it
  into a placeholder strips that.
- **No slot fills.** The children are the fallback.
- A widget **does not participate in the access plan** beyond its props. It
  reads no host data server-side, because it does not render server-side. Its
  props are evaluated in the page's pass and are therefore in the page's plan —
  which means placing a widget does **not** take anything out of the plan the
  way deferring does. Placing a widget *and* deferring it does.

## 3. Hydration, reconciled with E2

E2's rule is inference: *the compiler owns the components and knows each one's
hydration cost and interaction surface statically, so infer by default and allow
an explicit override.*

That rule cannot apply to a widget. The compiler does not own a widget's code,
did not compile it, and cannot see whether it binds events or reads media
queries. Inferring would mean guessing, and guessing wrong in the cheap
direction ships a dead component while guessing wrong in the expensive direction
ships JavaScript nobody needed.

**The combined rule, in one sentence:**

> Hydration is **inferred** for components the compiler compiled and
> **declared** by the host for widgets it did not, and an explicit directive at
> the placement site wins over either.

Three levels, most specific first: placement-site directive → host declaration
(widgets) or compiler inference (components) → nothing, meaning no client code.

E2's other commitments survive intact and should apply to widgets too: the
strategy is emitted in the build output so it is inspectable, `orbit build`
reports it per placement with its JS byte cost, and a page containing no widgets
and no interactive components ships no client runtime at all.

## 4. Failure semantics — the question that decides the blast radius

For a *behavior* attached to markup that already rendered, failure degrades by
construction: the markup is there, the enhancement is not. For a **placed
widget**, it does not — the widget *is* the content, and if its script never
loads there is a hole where the cart drawer was.

So the answer has to be chosen rather than inherited, and it decides whether one
broken widget takes down a page or a region.

**Proposed, and it mirrors the island rule that already ships:**

1. The server always renders the placeholder **with its fallback children**. A
   widget with no children renders an empty placeholder that occupies no space.
2. A widget that fails to load, throws while mounting, or is not registered in
   the runtime **leaves its fallback in place** and reports through the same DOM
   event channel the swap script uses. It does not clear, retry, or substitute
   an error message.
3. **Failure is per widget.** One widget failing must not prevent another from
   mounting, and must not touch anything outside its own placeholder.
4. The runtime never removes server-rendered content it did not put there.

Which makes the fallback the load-bearing part of a placement, not decoration —
and argues for the checker **warning** when a widget the host declared
`fallback: 'children'` is placed without any. That is a diagnostic worth having:
the failure it prevents is invisible until the day the CDN is down.

## 5. Versioning

Widgets are pinned **by major**, the same discipline components already follow,
and the same discipline `runtime/` shipped with.

- A theme records the widget major it was built against.
- The runtime refuses to mount a widget whose registered major differs from the
  one the theme pinned, and reports it rather than mounting something whose
  props may mean something else.
- The catalogue's own versions are CommerceOS's business. What this repository
  owns is that a mismatch is **detected and reported**, not silently tolerated.

## 6. Dependency, stated plainly

**This needs a client runtime, which does not exist.** `runtime/` is 1.4KB that
swaps island HTML; it does not mount components.

So J4 pulls **E1** (reactive backend) and **F** (runtime budget, single-bundle
rule) ahead of further hardening — which is what the Phase D verdict recommends
anyway. Hardening a language that cannot express a cart drawer is the wrong use
of the next two quarters.

**E1 is scoped down to what J4 needs**, and no further:

| Needed | Not needed yet |
|---|---|
| Mount a registered widget into a placeholder | `<let>` reactivity across a document |
| Typed props in, deserialized | A store vocabulary |
| A hydration trigger per strategy | An action vocabulary |
| A lifecycle: mount, unmount, error | Cross-widget state |
| Version check and failure reporting | Transitions (E3) |

A placed widget needs attributes in, a trigger, and a lifecycle. It does not
need the general reactive system, and building that first would be building for
a requirement the measurement did not produce.

The F-phase rules already apply from `runtime/`'s first commit — independent
version, SRI, size budget failing CI, one script tag, first in scope for audit —
so the widget runtime inherits them rather than negotiating them.

## 7. What this does not loosen

Checked against [scope.md](../scope.md)'s exclusion table, because a mechanism
that touches client code is exactly where an invariant gets traded away without
anyone noticing:

| Exclusion | Still holds because |
|---|---|
| JS in templates | The theme places a widget; it does not write one. |
| `Html` crossing a foreign boundary | No `Html` prop, same rule as a deferred island. |
| Orbit-rendered children inside foreign subtrees | The fallback is replaced *by* the widget, not composed *into* it. The widget owns its subtree from mount; Orbit owns it until then. One owner at a time. |
| Server-side execution of foreign modules | A widget never renders server-side. The placeholder and its fallback are all the engine produces. |
| Raw HTML sinks | A widget's props are typed values, not markup. |
| Dynamic member access | Unchanged; placement is a static call site. |

## 8. Open questions, listed rather than assumed

1. **Does a widget's placeholder need a stable id?** An island's does, for the
   swap. A widget may be locatable by position instead — worth deciding before
   the manifest grows a second id space.
2. **Can a widget be deferred?** They compose in principle. Whether the first
   version allows it is a scope decision, and the answer affects §4's failure
   matrix (two things can now fail independently).
3. **Should `fallback: 'children'` with no children be a warning or an error?**
   Argued as a warning above; an error is defensible and is the stricter default
   this project usually prefers.

These are decisions for the implementation brief, not gaps in this one.
