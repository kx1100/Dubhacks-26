// The renderer interface. The model (S, S.vis) holds what is shown; a renderer
// draws it and reports what the user does. main.js picks the renderer with
// useRenderer() before anything is drawn, and everything else reaches it through
// `renderer`.
//
// Renderer methods:
//   mount(container)      draw into this element (the canvas) and start listening
//   setGraph(vis, {fit})  show a new visible graph (load, filter, preset, expand level)
//   open(id), close(id)   a node was expanded/collapsed or its code card opened/closed
//                         (S.vis is already updated); keep the rest of the view in place
//   setCodeCard(id)       the source text of an open code card arrived or changed
//   refreshStyle()        redraw selection, focus dimming, highlights, AI path, impact
//                         tiers, search matches and diff status from S
//   centerOn(id, animate), fit(animate), zoom(factor), focus()
//   on(event, fn)         user input, see EVENTS
//   debug.nodes(cls), debug.edges(cls)
//                         ids of the drawn nodes / keys of the drawn edges having a
//                         class (all when cls is omitted), for tests
//
// EVENTS (arguments):
//   select (id)            a node was clicked
//   openSource (id)        a node was Ctrl/Cmd+clicked
//   activate (id)          a node was double-clicked
//   toggle (id)            its expand button was clicked
//   toggleCode (id)        its code button was clicked
//   openLine (id, line)    a line of its code card was clicked
//   reveal (id)            the label of a long arrow was clicked: go to that end
//   edgeSelect (key)       an arrow was clicked
//   background ()          empty space was clicked
//   rendered ()            the drawing was updated

/** @type {any} */
export let renderer = null;

export function useRenderer(r) {
  renderer = r;
}

/** A tiny event emitter for renderers: returns {on, emit}. */
export function emitter() {
  const handlers = new Map();
  return {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    emit(event, ...args) {
      for (const fn of handlers.get(event) || []) fn(...args);
    }
  };
}
