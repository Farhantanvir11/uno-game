/* Capacitor native bridge — only runs inside the Android shell.
 * Loaded from index.html. No-op on web. */
(function () {
  const Cap = window.Capacitor;
  if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;

  document.documentElement.classList.add("is-native");

  // Splash screen — hide once first paint settles (game.js will have started).
  const SplashScreen = Cap.Plugins && Cap.Plugins.SplashScreen;
  if (SplashScreen) {
    window.addEventListener("load", () => {
      setTimeout(() => SplashScreen.hide().catch(() => {}), 400);
    });
  }

  // Status bar — dark theme, fixed background.
  const StatusBar = Cap.Plugins && Cap.Plugins.StatusBar;
  if (StatusBar) {
    StatusBar.setBackgroundColor({ color: "#0b1020" }).catch(() => {});
    StatusBar.setStyle({ style: "DARK" }).catch(() => {});
  }

  // Hardware back button: close any open modal first; on root menu, exit.
  const App = Cap.Plugins && Cap.Plugins.App;
  if (App) {
    App.addListener("backButton", () => {
      // 1. Wild-card picker
      const wild = document.getElementById("wildPicker");
      if (wild && !wild.hidden) { wild.hidden = true; return; }

      // 2. Challenge +4 modal
      const challenge = document.getElementById("challengeModal");
      if (challenge && !challenge.hidden) { challenge.hidden = true; return; }

      // 3. Game-over panel — back to menu
      const gameOver = document.getElementById("gameOverPanel");
      if (gameOver && !gameOver.hidden) {
        const btn = document.getElementById("backToMenu");
        if (btn) { btn.click(); return; }
      }

      // 4. In a room/game — leave to menu
      const lobby = document.getElementById("lobbyScreen");
      const game  = document.getElementById("gameScreen");
      if ((lobby && !lobby.hidden) || (game && !game.hidden)) {
        const leave = document.getElementById("leaveRoomBtn") ||
                      document.getElementById("backToMenu");
        if (leave) { leave.click(); return; }
      }

      // 5. On menu — confirm exit
      if (confirm("Exit Last Card Battle?")) App.exitApp();
    });
  }
})();
