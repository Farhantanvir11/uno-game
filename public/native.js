/* Capacitor native bridge — only runs inside the Android shell.
 * Loaded from index.html. No-op on web. */
(function () {
  const Cap = window.Capacitor;
  if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;

  document.documentElement.classList.add("is-native");

  // Splash screen — hide once first paint settles (game.js will have started).
  const SplashScreen = Cap.Plugins && Cap.Plugins.SplashScreen;
  if (SplashScreen) {
    // Hide the native splash as soon as the WebView has any DOM, so the in-page
    // "Connecting to game server…" overlay (rendered by game.js) becomes visible
    // during the cold-start socket handshake instead of the bare splash.
    const hideSplash = () => SplashScreen.hide().catch(() => {});
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", hideSplash, { once: true });
    } else {
      hideSplash();
    }
  }

  // Status bar — dark theme, fixed background.
  const StatusBar = Cap.Plugins && Cap.Plugins.StatusBar;
  if (StatusBar) {
    StatusBar.setBackgroundColor({ color: "#0b1020" }).catch(() => {});
    StatusBar.setStyle({ style: "DARK" }).catch(() => {});
  }

  // Note: hardware back button is handled by handleHardwareBack() in game.js,
  // which knows about the real modal IDs and uses computed styles. Keeping
  // a second listener here would double-fire and close two layers at once.
})();
