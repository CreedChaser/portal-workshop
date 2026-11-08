# Supported rendering envelope

The canonical pure-portal renderer is **Euclidean unfolded rasterization with a
breadth-fair finite work scheduler**. Every admitted room copy is transformed,
clipped, depth-tested, and rasterized by the ordinary Euclidean pipeline. When
the finite release budget is exhausted, unadmitted portal branches remain
closed terminal surfaces. They are not rendered as holes and are not called
pixel-exact.

Release constants:

- recursive depth ceiling: 2,048 events;
- room-copy capacity: 4,097 copies;
- sub-pixel area rejection: the retained physical-pixel visibility predicate;
- deterministic overlap ownership: priority, then stable portal ID;
- fair scheduling: breadth first, with queued sibling reservation;
- DAG backend: exact state-map construction for its certified
  pure-translation rectangular domain, with fail-closed errors;
- compressed spaces: opt-in bounded metric extension, never the default
  pure-portal renderer, and never described as exact past its finite event cap.

Finite work cannot prove exact infinite recursion for arbitrary topology. The
release therefore uses the phrase **exact within the certified finite
envelope**, not unqualified “pixel-exact.”
