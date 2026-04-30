package com.lastcardbattle.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    // Allow audio (e.g. the intro sting) to autoplay without requiring
    // an explicit user gesture, which the WebView blocks by default.
    if (this.bridge != null && this.bridge.getWebView() != null) {
      this.bridge.getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
    }
  }
}
