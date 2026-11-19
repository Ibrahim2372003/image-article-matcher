import type { Logger } from "./jobs/processor.js";

/** JSON-lines logger. Callers pass controlled fields only (ids, codes); never article text, image data or secrets. */
export const jsonLogger: Logger = (level, msg, fields = {}) => {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
  (level === "error" ? console.error : console.log)(line);
};
