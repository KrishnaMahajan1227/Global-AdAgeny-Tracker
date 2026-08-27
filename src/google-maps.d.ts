// The Google Maps JavaScript SDK is loaded at runtime via a <script> tag
// (see FieldMapPage), so `window.google` isn't known to TypeScript by default.
// This just tells TS the property exists; it doesn't add real typings.
export {};

declare global {
  interface Window {
    google: any;
  }
}
