import { TYPERT_REMOTE } from "./typert.remote-client.js";
export const TYPERT = {
  package: TYPERT_REMOTE.package, face: "host", schemas: [],
  invocations: TYPERT_REMOTE.descriptors,
  model: { services: [{ key: "recorderController", exportName: "default", tags: [],
    summary: "Host-owned recorder operations with cancellation.",
    members: TYPERT_REMOTE.descriptors.map(({ method, parameters }) => ({
      kind: "method", name: method, signature: `${method}(${[...parameters.map(p => p.name), "signal"].join(", ")})`,
    })), types: [],
  }], events: [], objects: [] },
};
