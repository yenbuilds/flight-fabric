/**
 * Electron Integration for Launcher
 * 
 * This script detects if we're running in Electron and provides
 * Electron-specific functionality while maintaining backwards
 * compatibility with the standalone HTTP-based launcher.
 */

(function() {
  'use strict';

  const isElectron = !!window.electronAPI;

  /**
   * Log output panel for Electron mode
   */
  function createLogPanel() {
    if (!isElectron) return;

    // Create log panel if it doesn't exist
    let logSection = document.getElementById('electron-log-section');
    if (logSection) return;

    // Find the CLI section to insert before
    const cliSection = document.querySelector('.card:has(.cli-grid)');
    
    logSection = document.createElement('section');
    logSection.id = 'electron-log-section';
    logSection.className = 'card';
    logSection.innerHTML = `
      <h2><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>Backend Log</h2>
      <div id="electron-log" style="
        background: var(--bg-primary, #0b0e14);
        padding: 10px;
        max-height: 200px;
        overflow-y: auto;
        font-family: monospace;
        font-size: 12px;
        border-radius: 6px;
        color: #a0a0a0;
      "></div>
      <div style="margin-top: 10px; display: flex; gap: 10px;">
        <button class="btn btn-sm" onclick="clearElectronLog()">Clear</button>
        <label style="display: flex; align-items: center; gap: 5px;">
          <input type="checkbox" id="electron-autoscroll" checked>
          Auto-scroll
        </label>
      </div>
    `;

    if (cliSection) {
      cliSection.parentNode.insertBefore(logSection, cliSection);
    } else {
      document.querySelector('.container').appendChild(logSection);
    }
  }

  /**
   * Add log line to panel
   */
  function addLogLine(text, type = 'stdout') {
    const log = document.getElementById('electron-log');
    if (!log) return;

    const line = document.createElement('div');
    line.style.color = type === 'stderr' ? '#ff6b6b' : '#a0a0a0';
    line.textContent = text;
    log.appendChild(line);

    // Auto-scroll if enabled
    const autoscroll = document.getElementById('electron-autoscroll');
    if (autoscroll && autoscroll.checked) {
      log.scrollTop = log.scrollHeight;
    }

    // Limit to 500 lines
    while (log.children.length > 500) {
      log.removeChild(log.firstChild);
    }
  }

  /**
   * Clear log panel
   */
  window.clearElectronLog = function() {
    const log = document.getElementById('electron-log');
    if (log) log.innerHTML = '';
  };

  /**
   * Override functions for Electron mode
   */
  if (isElectron) {
    console.log('[launcher] Running in Electron mode');

    // Update header to show Electron mode
    const subtitle = document.querySelector('.subtitle');
    if (subtitle) {
      subtitle.innerHTML = 'Launcher &amp; Control Panel <span style="color: #4ecdc4; font-size: 12px;">(Electron)</span>';
    }

    // Create log panel
    document.addEventListener('DOMContentLoaded', createLogPanel);
    if (document.readyState !== 'loading') createLogPanel();

    // Override backend controls
    window.startBackend = function() {
      window.electronAPI.startBackend();
      showToast('Starting backend...', 'info');
    };

    window.stopBackend = function() {
      window.electronAPI.stopBackend();
      showToast('Stopping backend...', 'info');
    };

    window.startAll = function() {
      window.electronAPI.startBackend();
      showToast('Starting services...', 'info');
    };

    window.stopAll = function() {
      window.electronAPI.stopBackend();
      showToast('Stopping services...', 'info');
    };

    // Status update for Electron
    window.updateStatus = async function() {
      try {
        const { status } = await window.electronAPI.getBackendStatus();
        
        const dot = document.getElementById('status-backend');
        if (dot) {
          switch (status) {
            case 'running':
              dot.className = 'status-dot running';
              dot.style.background = ''; // Use CSS default
              break;
            case 'starting':
            case 'stopping':
              dot.className = 'status-dot running';
              dot.style.background = '#ffd700'; // Yellow/amber for transitional states
              break;
            case 'error':
              dot.className = 'status-dot stopped';
              dot.style.background = '#ff6b6b';
              break;
            default:
              dot.className = 'status-dot stopped';
              dot.style.background = ''; // Use CSS default
          }
        }

        // HTTP server status (frontend static file server)
        const httpDot = document.getElementById('status-httpServer');
        if (httpDot && window.electronAPI.getHttpStatus) {
          try {
            const httpResult = await window.electronAPI.getHttpStatus();
            if (httpResult.status === 'running') {
              httpDot.className = 'status-dot running';
            } else {
              httpDot.className = 'status-dot stopped';
            }
            // Update Desktop UI link with resolved port
            if (httpResult.port) {
              const link = document.getElementById('desktop-ui-link');
              if (link) link.href = `http://localhost:${httpResult.port}/frontend/index.html`;
              // Update HTTP server port label
              const httpLabel = document.querySelector('.service-row:has(#status-httpServer) .service-actions');
              if (httpLabel && httpLabel.dataset.autoLabel) {
                httpLabel.innerHTML = `<span style="color: #666; font-size: 12px;">Auto-started on port ${httpResult.port}</span>`;
              }
            }
          } catch (httpErr) {
            console.error('[launcher] HTTP status error:', httpErr);
          }
        }

      } catch (err) {
        console.error('[launcher] Status update error:', err);
      }
    };

    // Listen for backend events
    window.electronAPI.onBackendStatus((data) => {
      console.log('[launcher] Backend status:', data);
      window.updateStatus();
      
      if (data.status === 'running') {
        showToast('Backend started', 'success');
      } else if (data.status === 'stopped') {
        showToast(`Backend stopped${data.exitCode !== undefined ? ` (code ${data.exitCode})` : ''}`, 'info');
      } else if (data.status === 'error') {
        showToast(`Backend error: ${data.error}`, 'error');
      }
    });

    window.electronAPI.onBackendLog((data) => {
      addLogLine(data.text, data.type);
    });

    // Load existing logs
    window.electronAPI.getBackendLogs().then(logs => {
      logs.forEach(log => addLogLine(log.text, log.type));
    });

    // Disable HTTP server controls in Electron
    // (it can still be started manually outside)
    const httpActions = document.querySelector('.service-row:has(#status-httpServer) .service-actions');
    
    if (httpActions) {
      httpActions.dataset.autoLabel = 'true';
      httpActions.innerHTML = '<span style="color: #666; font-size: 12px;">Auto-started</span>';
    }

    // Initial status check
    setTimeout(window.updateStatus, 500);
  }

})();
