import type { CapacitorConfig } from '@capacitor/cli'

// The game is bundled from dist/ (no server.url): it runs fully offline inside the app.
const config: CapacitorConfig = {
  appId: 'mn.driftking.steppe',
  appName: 'Drift King: Steppe Neon',
  webDir: 'dist',
  backgroundColor: '#123d6b',
  ios: {
    contentInset: 'never',
    backgroundColor: '#123d6b',
    scrollEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 1200,
      backgroundColor: '#123d6b',
      showSpinner: false,
    },
    StatusBar: { overlaysWebView: true, style: 'DARK' },
  },
}

export default config
