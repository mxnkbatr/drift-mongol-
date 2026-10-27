import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'mn.driftking.steppe',
  appName: 'Drift King: Steppe Neon',
  webDir: 'dist',
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 1200,
      backgroundColor: '#071a38',
      showSpinner: false,
    },
  },
}

export default config
