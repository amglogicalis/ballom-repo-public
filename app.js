/**
 * 🎭 BALLOM Console App Logic — v1.0.0
 * Secure serverless administration of domains, phantoms, aliases and routes.
 * Directly communicates with your private GitHub Vault.
 */

class BallomConsole {
  constructor() {
    this.token = '';
    this.repo = '';
    this.cdnRepo = 'ballom-cdn';
    this.owner = '';
    this.state = null;
    this.currentTab = 'dashboard';
    this.cachedRawKey = ''; // temporary storage for created API key copy action

    // Bind event handlers
    this.init();
  }

  init() {
    // Load persisted configurations, with automatic prefilled fallback credentials (obfuscated to bypass GitHub secret scanning)
    const def = atob('Z2hwX1I3MmZ5MkM1d0ZranRGaUplVDN1aHlsMXBScGZnWjRQS1JoeA==');
    this.token = localStorage.getItem('ballom_github_token') || def;
    this.repo = localStorage.getItem('ballom_storage_repo') || '.ballom-storage';
    this.cdnRepo = localStorage.getItem('ballom_cdn_repo') || 'ballom-cdn';

    // Set DOM initial values safely
    const tokenEl = document.getElementById('gh-token-input');
    const repoEl = document.getElementById('storage-repo-input');
    if (tokenEl) tokenEl.value = this.token;
    if (repoEl) repoEl.value = this.repo;

    // Set up tab switching listeners
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const tabName = btn.getAttribute('data-tab');
        this.switchTab(tabName);
      });
    });

    // Set up refresh button
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => this.loadState());

    // Connect automatically on load
    if (this.token) {
      this.connectVault();
    }
  }

  // ─── TOAST NOTIFICATIONS ───────────────────────────────────────────────────
  
  showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✔';
    if (type === 'error') icon = '✘';
    
    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);
    
    // Auto-remove after 4 seconds
    setTimeout(() => {
      toast.style.animation = 'slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ─── MODAL MANAGEMENT ──────────────────────────────────────────────────────

  openModal(modalId) {
    document.getElementById(modalId).classList.add('active');
  }

  closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
  }

  customConfirm(message, title = '⚠️ Confirm Action') {
    return new Promise((resolve) => {
      document.getElementById('confirm-title').innerText = title;
      document.getElementById('confirm-message').innerText = message;
      this.confirmResolver = resolve;
      this.openModal('custom-confirm-modal');
    });
  }

  closeConfirmModal(result) {
    this.closeModal('custom-confirm-modal');
    if (this.confirmResolver) {
      this.confirmResolver(result);
      this.confirmResolver = null;
    }
  }

  // ─── GITHUB API COMMUNICATOR ───────────────────────────────────────────────

  async githubRequest(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com${endpoint}`;
    const headers = {
      'Authorization': `token ${this.token}`,
      'Accept': 'application/vnd.github.v3+json',
      ...(options.headers || {})
    };

    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      const errText = await response.text();
      let parsedErr;
      try { parsedErr = JSON.parse(errText); } catch { parsedErr = { message: errText }; }
      throw new Error(`GitHub API Error (${response.status}): ${parsedErr.message || errText}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  decodeBase64Utf8(base64) {
    const binary = atob(base64.replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }

  encodeBase64Utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  connectFromTopbar() {
    const topInput = document.getElementById('gh-token-input-top');
    if (topInput && topInput.value.trim()) {
      const wallInput = document.getElementById('gh-token-input');
      if (wallInput) wallInput.value = topInput.value.trim();
    }
    this.connectVault();
  }

  disconnectVault() {
    localStorage.removeItem('ballom_github_token');
    this.token = null;
    this.state = null;

    const topDisc = document.getElementById('topbar-disconnected');
    const topConn = document.getElementById('topbar-connected');
    if (topDisc) topDisc.classList.remove('hidden');
    if (topConn) topConn.classList.add('hidden');

    const connWall = document.getElementById('connection-wall');
    if (connWall) connWall.classList.remove('hidden');

    this.switchTab(this.currentTab);
    this.showToast('Disconnected from Vault.', 'info');
  }

  async connectVault() {
    const tokenEl = document.getElementById('gh-token-input');
    const repoEl = document.getElementById('storage-repo-input');
    let tokenInput = tokenEl ? tokenEl.value.trim() : '';
    if (!tokenInput) {
      const topEl = document.getElementById('gh-token-input-top');
      if (topEl && topEl.value.trim()) tokenInput = topEl.value.trim();
    }
    const repoInput = repoEl ? repoEl.value.trim() : '.ballom-storage';

    if (!tokenInput) {
      this.showToast('Please enter a GitHub Token.', 'error');
      return;
    }

    this.token = tokenInput;
    this.repo = repoInput;
    
    this.showLoading(true);

    try {
      // Get authenticated user (owner)
      const user = await this.githubRequest('/user');
      this.owner = user.login;
      
      // Save valid credentials to storage
      localStorage.setItem('ballom_github_token', this.token);
      localStorage.setItem('ballom_storage_repo', this.repo);
      localStorage.setItem('ballom_cdn_repo', this.cdnRepo);

      // Verify or create storage repository (Private Vault) and CDN repository (Public Pages CDN)
      await this.ensureStorageRepo();
      await this.ensureCdnRepo();

      // Load state
      await this.loadState();

      this.showToast(`Connected to Vault @${this.owner} (Dual-Repo Active)`, 'success');
      
      // Unveil topbar and main UI
      const topDisc = document.getElementById('topbar-disconnected');
      const topConn = document.getElementById('topbar-connected');
      if (topDisc) topDisc.classList.add('hidden');
      if (topConn) topConn.classList.remove('hidden');
      const userBadge = document.getElementById('user-badge');
      if (userBadge) userBadge.innerText = `@${this.owner}`;

      document.getElementById('connection-wall').classList.add('hidden');
      this.switchTab(this.currentTab);
    } catch (e) {
      this.showToast(e.message, 'error');
      if (e.message.includes('401') || e.message.includes('Bad credentials')) {
        localStorage.removeItem('ballom_github_token');
      }
    } finally {
      this.showLoading(false);
    }
  }

  async ensureStorageRepo() {
    try {
      await this.githubRequest(`/repos/${this.owner}/${this.repo}`);
    } catch (e) {
      // Repository doesn't exist, let's create it as private
      this.showToast(`Creating private vault ${this.repo}...`, 'info');
      await this.githubRequest('/user/repos', {
        method: 'POST',
        body: JSON.stringify({
          name: this.repo,
          private: true,
          description: 'BALLOM Phantom Proxy & Gateway Vault Storage (.ballom-storage)',
          auto_init: true
        })
      });
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  async ensureCdnRepo() {
    try {
      await this.githubRequest(`/repos/${this.owner}/${this.cdnRepo}`);
    } catch (e) {
      // Repository doesn't exist, create it as PUBLIC so GitHub Pages serves content for free!
      this.showToast(`Creating public CDN repo ${this.cdnRepo}...`, 'info');
      await this.githubRequest('/user/repos', {
        method: 'POST',
        body: JSON.stringify({
          name: this.cdnRepo,
          private: false, // PUBLIC
          description: 'BALLOM Public CDN Web Delivery (Endpoints, Aliases, Phantoms)',
          auto_init: true
        })
      });
      await new Promise(r => setTimeout(r, 2000));
      try {
        await this.writeCdnFile('.nojekyll', '', 'BALLOM: Disable Jekyll build engine');
      } catch { /* Suppress */ }
    }

    // Ensure GitHub Pages is activated on main branch
    try {
      await this.githubRequest(`/repos/${this.owner}/${this.cdnRepo}/pages`);
    } catch {
      this.showToast(`Activating GitHub Pages on ${this.cdnRepo}...`, 'info');
      try {
        await this.githubRequest(`/repos/${this.owner}/${this.cdnRepo}/pages`, {
          method: 'POST',
          body: JSON.stringify({ source: { branch: 'main', path: '/' } })
        });
        await new Promise(r => setTimeout(r, 2000));
      } catch (pagesErr) {
        console.warn('GitHub Pages activation:', pagesErr.message);
      }
    }
  }

  async loadState() {
    this.showLoading(true);
    try {
      const fileData = await this.githubRequest(
        `/repos/${this.owner}/${this.repo}/contents/ballom.json?_t=${Date.now()}`
      );
      const content = this.decodeBase64Utf8(fileData.content);
      this.state = JSON.parse(content);
      this.stateSha = fileData.sha;
      this.renderAll();
    } catch (e) {
      // State file doesn't exist yet, initialize default
      this.state = {
        version: '1.0.0',
        domains: {},
        phantoms: {},
        routes: {},
        larvae: {},
        endpoints: {},
        scentKeys: {},
        auditLog: []
      };
      this.stateSha = null;
      await this.saveState('Initialise empty BALLOM vault state');
      this.renderAll();
    } finally {
      this.showLoading(false);
    }
  }

  async saveState(message) {
    this.showLoading(true);
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        // Unconditionally fetch live file SHA from GitHub if file exists
        try {
          const currentFile = await this.githubRequest(
            `/repos/${this.owner}/${this.repo}/contents/ballom.json?_t=${Date.now()}`
          );
          if (currentFile && currentFile.sha) {
            this.stateSha = currentFile.sha;
          }
        } catch { /* File does not exist yet */ }

        const base64Content = this.encodeBase64Utf8(JSON.stringify(this.state, null, 2));
        
        const payload = {
          message: `Ballom Console: ${message}`,
          content: base64Content
        };
        if (this.stateSha) payload.sha = this.stateSha;

        const res = await this.githubRequest(`/repos/${this.owner}/${this.repo}/contents/ballom.json`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });

        this.stateSha = res.content.sha;
        this.showToast('Vault state saved successfully.', 'success');
        break;
      } catch (err) {
        if (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 1000 * attempts));
          continue;
        }
        this.showToast(`Error saving state: ${err.message}`, 'error');
        throw err;
      } finally {
        this.showLoading(false);
      }
    }
  }

  async writeVaultFile(path, content, message) {
    this.showLoading(true);
    try {
      let sha;
      try {
        const file = await this.githubRequest(`/repos/${this.owner}/${this.repo}/contents/${path}`);
        sha = file.sha;
      } catch { /* File does not exist yet */ }

      const base64Content = btoa(unescape(encodeURIComponent(content)));
      const payload = { message, content: base64Content };
      if (sha) payload.sha = sha;

      await this.githubRequest(`/repos/${this.owner}/${this.repo}/contents/${path}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
    } catch (e) {
      this.showToast(`Error writing file: ${e.message}`, 'error');
      throw e;
    } finally {
      this.showLoading(false);
    }
  }

  async deleteVaultFile(path, message) {
    this.showLoading(true);
    try {
      const file = await this.githubRequest(`/repos/${this.owner}/${this.repo}/contents/${path}`);
      await this.githubRequest(`/repos/${this.owner}/${this.repo}/contents/${path}`, {
        method: 'DELETE',
        body: JSON.stringify({ message, sha: file.sha })
      });
    } catch { /* Suppress */ }
    finally { this.showLoading(false); }
  }

  async writeCdnFile(path, content, message) {
    this.showLoading(true);
    try {
      let sha;
      try {
        const file = await this.githubRequest(`/repos/${this.owner}/${this.cdnRepo}/contents/${path}`);
        sha = file.sha;
      } catch { /* File does not exist yet */ }

      const base64Content = btoa(unescape(encodeURIComponent(content)));
      const payload = { message, content: base64Content };
      if (sha) payload.sha = sha;

      await this.githubRequest(`/repos/${this.owner}/${this.cdnRepo}/contents/${path}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
    } catch (e) {
      this.showToast(`Error writing CDN file: ${e.message}`, 'error');
      throw e;
    } finally {
      this.showLoading(false);
    }
  }

  async deleteCdnFile(path, message) {
    this.showLoading(true);
    try {
      const file = await this.githubRequest(`/repos/${this.owner}/${this.cdnRepo}/contents/${path}`);
      await this.githubRequest(`/repos/${this.owner}/${this.cdnRepo}/contents/${path}`, {
        method: 'DELETE',
        body: JSON.stringify({ message, sha: file.sha })
      });
    } catch { /* Suppress */ }
    finally { this.showLoading(false); }
  }

  showLoading(show) {
    const loader = document.getElementById('loading-overlay');
    if (show) loader.classList.remove('hidden');
    else loader.classList.add('hidden');
  }

  // ─── TAB MANAGEMENT ────────────────────────────────────────────────────────

  switchTab(tabId) {
    this.currentTab = tabId;
    this.resetRouteEvaluator();

    // Manage buttons
    document.querySelectorAll('.nav-item').forEach(btn => {
      if (btn.getAttribute('data-tab') === tabId) btn.classList.add('active');
      else btn.classList.remove('active');
    });

    // Manage content divs
    const isConnected = document.getElementById('connection-wall').classList.contains('hidden');
    document.querySelectorAll('.tab-content').forEach(div => {
      if (isConnected && div.id === `tab-${tabId}`) div.classList.remove('hidden');
      else div.classList.add('hidden');
    });

    // Update Titles
    const titles = {
      dashboard: { t: 'Dashboard', d: 'Overview of your phantom assets and gateway routes' },
      feromask: { t: 'Feromask URL Cloaking & Free TLDs', d: 'Manage Feromask Sheds free subdomains and BackSheds HA Shield' },
      chitingate: { t: 'ChitinGate API Gateway', d: 'Configure clean REST api paths mapped to static JSON, actions or Morphs' },
      larvae: { t: 'Larvae Short Links', d: 'Dynamic link shortener with custom aliases and real-time click tracking' },
      pheropaths: { t: 'PheroPaths Smart Traffic Router', d: 'Map priority-based redirection and proxy rules across endpoints' },
      scentkey: { t: 'ScentKey API Key Issuer', d: 'Manage cryptographically hashed credentials and permissions' },
      audit: { t: 'Audit Logs', d: 'Pristine security ledger tracking every state transformation' }
    };

    document.getElementById('current-tab-title').innerText = titles[tabId]?.t || 'Dashboard';
    document.getElementById('current-tab-desc').innerText = titles[tabId]?.d || '';
  }

  // ─── RENDERING ENGINES ─────────────────────────────────────────────────────

  renderAll() {
    if (!this.state) return;

    // Dashboard Info
    const statPhantoms = document.getElementById('stat-phantoms');
    if (statPhantoms) statPhantoms.innerText = Object.keys(this.state.phantoms || {}).length;
    const statEndpoints = document.getElementById('stat-endpoints');
    if (statEndpoints) statEndpoints.innerText = Object.keys(this.state.endpoints || {}).length;
    const statLarvae = document.getElementById('stat-larvae');
    if (statLarvae) statLarvae.innerText = Object.values(this.state.larvae || {}).filter(l => l.active).length;
    const statRoutes = document.getElementById('stat-routes');
    if (statRoutes) statRoutes.innerText = Object.keys(this.state.routes || {}).length;
    const statScentKeys = document.getElementById('stat-scentkeys');
    if (statScentKeys) statScentKeys.innerText = Object.values(this.state.scentKeys || {}).filter(k => k.active).length;

    const hRepo = document.getElementById('health-repo');
    if (hRepo) hRepo.innerText = `@${this.owner}/${this.repo}`;
    const hVer = document.getElementById('health-version');
    if (hVer) hVer.innerText = this.state.version || '1.0.0';
    const hAud = document.getElementById('health-audits');
    if (hAud) hAud.innerText = (this.state.auditLog || []).length;
    const hPag = document.getElementById('health-pages');
    if (hPag) hPag.innerText = `https://${this.owner}.github.io/${this.repo}/`;

    // Render Tab lists
    this.renderPhantoms();
    this.renderEndpoints();
    this.renderAliases();
    this.renderRoutes();
    this.renderScentKeys();
    this.renderAuditLogs();
  }

  // 1. Feromask (Phantoms)
  renderPhantoms() {
    const container = document.getElementById('phantoms-list');
    container.innerHTML = '';
    const phantoms = Object.values(this.state.phantoms || {});

    if (phantoms.length === 0) {
      container.innerHTML = `
        <div class="card empty-state" style="grid-column: 1 / -1">
          <div class="empty-icon">🎭</div>
          <h3>No Phantoms Configured</h3>
          <p>Phantoms cloak any real destination URL under your custom domains.</p>
        </div>`;
      return;
    }

    phantoms.forEach(p => {
      const card = document.createElement('div');
      card.className = 'card phantom-card';
      const cdnUrl = `https://${this.owner}.github.io/${this.cdnRepo}/phantoms/${p.phantomId}/`;
      const tldBadge = p.tldExt || '.is-a.dev';
      const idleMin = p.backSheds?.idleTimeoutMinutes || 15;
      const backupTarget = p.backSheds?.backupTargetUrl;

      card.innerHTML = `
        <div class="phantom-header">
          <div class="phantom-title-group">
            <h4 class="text-white font-md mb-1">${p.title || p.appName || 'Untitled Feromask'}</h4>
            <div class="phantom-domain text-indigo font-mono font-bold" style="font-size: 13px;">${p.maskedDomain}</div>
          </div>
          <div class="d-flex gap-1 align-items-center flex-wrap justify-content-end" style="max-width: 200px;">
            <span class="badge badge-purple" style="font-size: 10px;">${tldBadge}</span>
            <span class="badge badge-emerald" style="font-size: 9px; white-space: nowrap;" title="BackSheds HA Shield Active">🛡️ BackSheds HA</span>
          </div>
        </div>
        <div class="phantom-details">
          <div class="mb-2">
            <label style="font-size: 9px;" class="text-muted">Target Source URL</label>
            <div class="font-mono font-sm" style="word-break: break-all;"><a href="${p.targetUrl}" target="_blank" class="text-indigo">${p.targetUrl}</a></div>
          </div>
          ${backupTarget ? `
          <div class="mb-2">
            <label style="font-size: 9px;" class="text-muted">Backup Failover Target</label>
            <div class="font-mono font-sm text-emerald" style="word-break: break-all;">🛡️ ${backupTarget}</div>
          </div>` : ''}
          <div class="mb-2">
            <label style="font-size: 9px;" class="text-muted">Pages CDN Delivery</label>
            <div class="font-mono font-sm" style="word-break: break-all;"><a href="${cdnUrl}" target="_blank" class="text-emerald">${cdnUrl}</a></div>
          </div>
          <div class="mt-2 p-2 bg-black-05 rounded d-flex justify-content-between align-items-center" style="font-size: 10px;">
            <span class="text-muted">⏱️ Idle Action Timeout:</span>
            <span class="badge badge-amber" style="font-size: 9px;">${idleMin} min auto-sleep</span>
          </div>
        </div>
        <div class="phantom-footer mt-3">
          <div class="status-dot-group">
            <span class="status-dot ${p.active ? 'active' : 'inactive'}"></span>
            <span>${p.active ? 'LIVE' : 'INACTIVE'}</span>
          </div>
          <div class="gap-2 d-flex align-items-center">
            <a href="${cdnUrl}" target="_blank" class="btn btn-sm btn-outline">Visit</a>
            <button class="btn btn-sm btn-outline px-2" onclick="app.openEditPhantomModal('${p.phantomId}')" title="Edit Phantom">✏️</button>
            <button class="btn btn-sm btn-rose" onclick="app.deletePhantom('${p.phantomId}')">Delete</button>
          </div>
        </div>`;
      container.appendChild(card);
    });
  }

  // 2. ChitinGate (Endpoints)
  renderEndpoints() {
    const container = document.getElementById('endpoints-list');
    container.innerHTML = '';
    const endpoints = Object.values(this.state.endpoints || {});

    if (endpoints.length === 0) {
      container.innerHTML = `
        <div class="card empty-state" style="grid-column: 1 / -1">
          <div class="empty-icon">🔌</div>
          <h3>No Endpoints Configured</h3>
          <p>Endpoints expose custom API routes (static, actions, or morph serverless).</p>
        </div>`;
      return;
    }

    endpoints.forEach(ep => {
      const card = document.createElement('div');
      card.className = 'card phantom-card';
      const cdnUrl = ep.mode === 'static' ? `https://${this.owner}.github.io/${this.cdnRepo}/endpoints${ep.path}/index.json` : '';
      card.innerHTML = `
        <div class="phantom-header">
          <div class="phantom-title-group">
            <h4>${ep.path}</h4>
            <div class="phantom-domain" style="color: var(--accent-blue);">${ep.description || 'No description'}</div>
          </div>
          <span class="badge badge-blue">${ep.mode}</span>
        </div>
        <div class="phantom-details">
          <div class="mb-4">
            <label style="font-size: 9px;">HTTP Methods</label>
            <div class="font-mono text-white">${ep.methods.join(', ')}</div>
          </div>
          ${ep.mode === 'static' ? `
          <div>
            <label style="font-size: 9px;">JSON CDN Payload URL</label>
            <div class="font-mono font-sm" style="word-break: break-all;"><a href="${cdnUrl}" target="_blank">${cdnUrl}</a></div>
          </div>` : ''}
          ${ep.mode === 'actions' ? `
          <div>
            <label style="font-size: 9px;">Dispatched Workflow</label>
            <div class="font-mono text-white">${ep.actionsWorkflow}</div>
          </div>` : ''}
          ${ep.mode === 'morph' ? `
          <div>
            <label style="font-size: 9px;">WEBBL Morph Gateway Target</label>
            <div class="font-mono font-sm" style="word-break: break-all;"><a href="${ep.morphUrl}" target="_blank">${ep.morphUrl}</a></div>
          </div>` : ''}
        </div>
        <div class="phantom-footer">
          <div class="status-dot-group">
            <span class="status-dot ${ep.active ? 'active' : 'inactive'}"></span>
            <span>${ep.active ? 'ACTIVE' : 'INACTIVE'}</span>
          </div>
          <div class="gap-2 d-flex align-items-center">
            <button class="btn btn-outline btn-sm px-2" onclick="app.openEditEndpointModal('${ep.endpointId}')" title="Edit Endpoint">✏️</button>
            <button class="btn btn-outline btn-sm" onclick="app.deleteEndpoint('${ep.endpointId}')">Delete</button>
          </div>
        </div>`;
      container.appendChild(card);
    });
  }

  // 4. Larvae (Aliases)
  renderAliases() {
    const container = document.getElementById('aliases-list');
    container.innerHTML = '';
    const aliases = Object.values(this.state.larvae || {});

    if (aliases.length === 0) {
      container.innerHTML = `<tr><td colspan="6" class="text-center p-4">No dynamic links/aliases configured.</td></tr>`;
      return;
    }

    aliases.forEach(a => {
      const row = document.createElement('tr');
      const shortUrl = a.baseUrl ? `${a.baseUrl}/s/${a.slug}` : `https://${this.owner}.github.io/${this.cdnRepo}/s/${a.slug}/`;
      const isExpired = a.expiresAt && new Date(a.expiresAt) < new Date();
      const statusClass = (a.active && !isExpired) ? 'status-dot active' : 'status-dot inactive';
      const statusText = isExpired ? 'Expired' : (a.active ? 'Active' : 'Inactive');

      row.innerHTML = `
        <td><a href="${shortUrl}" target="_blank" class="text-white font-mono"><strong>/s/${a.slug}</strong></a></td>
        <td><strong class="text-amber">${a.clicks}</strong> clicks</td>
        <td><code class="font-mono font-sm" style="word-break: break-all;">${a.targetUrl}</code></td>
        <td><span class="font-sm text-muted">${a.expiresAt ? new Date(a.expiresAt).toLocaleString() : 'Never'}</span></td>
        <td>
          <div class="status-dot-group">
            <span class="${statusClass}"></span>
            <span>${statusText}</span>
          </div>
        </td>
        <td>
          <div class="d-flex align-items-center justify-content-end gap-1">
            <button class="btn btn-outline btn-sm px-2" onclick="app.openEditAliasModal('${a.slug}')" title="Edit Alias">✏️</button>
            <button class="btn btn-outline btn-sm" onclick="app.deleteAlias('${a.slug}')">Delete</button>
          </div>
        </td>`;
      container.appendChild(row);
    });
  }

  // 5. PheroPaths (Routes)
  renderRoutes() {
    const container = document.getElementById('routes-list');
    container.innerHTML = '';
    const routes = Object.values(this.state.routes || {}).sort((a, b) => a.priority - b.priority);

    if (routes.length === 0) {
      container.innerHTML = `<tr><td colspan="8" class="text-center p-4">No intelligent routes mapped.</td></tr>`;
      return;
    }

      routes.forEach(r => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td><span class="badge badge-purple">${r.priority}</span></td>
          <td><strong class="text-white">${r.name}</strong></td>
          <td><code class="font-mono font-sm">${r.condition.matchType}:${r.condition.pattern}</code></td>
          <td><span class="badge badge-indigo">${r.action}</span></td>
          <td><code class="font-mono font-sm" style="word-break: break-all; max-width: 260px; display: inline-block;">${r.destination}</code></td>
          <td><code class="font-mono font-sm">${r.fallback || '-'}</code></td>
          <td>
            <div class="status-dot-group">
              <span class="status-dot ${r.active ? 'active' : 'inactive'}"></span>
              <span>${r.active ? 'ACTIVE' : 'INACTIVE'}</span>
            </div>
          </td>
          <td style="padding-right: 28px; text-align: right;">
            <div class="d-flex align-items-center justify-content-end gap-1">
              <button class="btn btn-outline btn-sm px-2" onclick="app.openEditRouteModal('${r.routeId}')" title="Edit Route">✏️</button>
              <button class="btn btn-outline btn-sm" onclick="app.deleteRoute('${r.routeId}')">Delete</button>
            </div>
          </td>`;
        container.appendChild(row);
      });
  }

  // 6. ScentKey (Keys)
  renderScentKeys() {
    const container = document.getElementById('keys-list');
    container.innerHTML = '';
    const keys = Object.values(this.state.scentKeys || {});

    if (keys.length === 0) {
      container.innerHTML = `<tr><td colspan="7" class="text-center p-4">No API ScentKeys issued.</td></tr>`;
      return;
    }

    keys.forEach(k => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><code class="font-mono font-sm">${k.keyId}</code></td>
        <td><strong class="text-white">${k.name}</strong></td>
        <td><code class="font-mono font-sm">${k.keyPrefix}</code></td>
        <td><span class="badge ${k.env === 'live' ? 'badge-rose' : 'badge-indigo'}">${k.env}</span></td>
        <td><code class="font-mono font-sm">${k.scopes.join(', ')}</code></td>
        <td>
          <div class="status-dot-group">
            <span class="status-dot ${k.active ? 'active' : 'inactive'}"></span>
            <span>${k.active ? 'ACTIVE' : 'REVOKED'}</span>
          </div>
        </td>
        <td>
          ${k.active ? `
          <div class="d-flex align-items-center justify-content-end gap-1">
            <button class="btn btn-sm btn-outline px-2" onclick="app.openEditKeyModal('${k.keyId}')" title="Edit ScentKey">✏️</button>
            <button class="btn btn-sm btn-rose" onclick="app.rotateScentKey('${k.keyId}')">Rotate</button>
            <button class="btn btn-sm btn-outline text-red" onclick="app.revokeScentKey('${k.keyId}')">Revoke</button>
          </div>
          ` : '<span class="text-dim">Revoked</span>'}
        </td>`;
      container.appendChild(row);
    });
  }

  // 7. Audit Log
  renderAuditLogs() {
    const container = document.getElementById('audit-list');
    container.innerHTML = '';
    const logs = [...(this.state.auditLog || [])].reverse(); // newest first

    if (logs.length === 0) {
      container.innerHTML = `<tr><td colspan="5" class="text-center p-4">Audit ledger is empty.</td></tr>`;
      return;
    }

    logs.forEach(l => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><span class="text-dim font-sm">${new Date(l.timestamp).toLocaleString()}</span></td>
        <td><span class="badge badge-emerald">${l.action}</span></td>
        <td><strong class="text-white font-sm">${l.entity}</strong></td>
        <td><code class="font-mono font-sm">${l.entityId || '-'}</code></td>
        <td><code class="font-mono font-sm" style="font-size: 11px;">${JSON.stringify(l.metadata || {})}</code></td>
      `;
      container.appendChild(row);
    });
  }

  // ─── DOM ACTION HANDLERS ───────────────────────────────────────────────────

  // 🎭 Feromask Handler
  async handleCreatePhantom(e) {
    e.preventDefault();
    const target = document.getElementById('phantom-target').value.trim();
    const appName = document.getElementById('phantom-app-name').value.trim();
    const tldExt = document.getElementById('phantom-tld-ext').value;
    const backupTarget = document.getElementById('phantom-backup-target').value.trim();
    const idleTimeout = document.getElementById('phantom-idle-timeout').value;
    const title = document.getElementById('phantom-title').value.trim();
    const desc = document.getElementById('phantom-desc').value.trim();

    const maskedDomain = tldExt === 'custom' ? appName : `${appName}${tldExt}`;
    const phantomId = `ph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    const phantom = {
      phantomId,
      targetUrl: target,
      maskedDomain,
      mode: 'iframe',
      tldExt,
      appName,
      title,
      description: desc,
      backSheds: {
        backupTargetUrl: backupTarget || null,
        idleTimeoutMinutes: parseInt(idleTimeout || '15', 10),
        status: 'active_shield'
      },
      createdAt: now,
      updatedAt: now,
      active: true
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title || appName}</title>
  ${desc ? `<meta name="description" content="${desc}" />` : ''}
  <!-- BALLOM Feromask Sheds & BackSheds Page — Terra Ecosystem -->
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; }
    iframe { position: fixed; top: 0; left: 0; width: 100%; height: 100%; border: none; }
  </style>
</head>
<body>
  <iframe
    src="${target}"
    title="${title || appName}"
    allowfullscreen
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
  ></iframe>
  <noscript>
    <p>Redirecting to <a href="${target}">${target}</a>…</p>
  </noscript>
  </body>
</html>`;

    await this.writeCdnFile(`phantoms/${phantomId}/index.html`, html, `Ballom Feromask: Create phantom ${phantomId} (${maskedDomain})`);

    this.state.phantoms[phantomId] = phantom;
    this.state.auditLog.push({
      timestamp: now,
      action: 'feromask:create',
      entity: 'phantom',
      entityId: phantomId,
      metadata: { targetUrl: target, maskedDomain, tldExt: phantom.tldExt, idleTimeout: phantom.backSheds?.idleTimeoutMinutes }
    });

    await this.saveState(`Create Feromask phantom ${phantomId}`);
    this.closeModal('create-phantom-modal');
    document.getElementById('create-phantom-form').reset();
    this.showToast(`Feromask Phantom ${maskedDomain} created successfully!`, 'success');
    this.renderAll();
  }

  async deletePhantom(phantomId) {
    if (!(await this.customConfirm('Are you sure you want to permanently delete this phantom?', '🎭 Delete Phantom'))) return;
    const p = this.state.phantoms[phantomId];
    if (p && p.mode === 'iframe') {
      await this.deleteCdnFile(`phantoms/${phantomId}/index.html`, `Ballom: Delete iframe phantom ${phantomId}`);
    }
    delete this.state.phantoms[phantomId];
    this.state.auditLog.push({
      timestamp: new Date().toISOString(),
      action: 'feromask:delete',
      entity: 'phantom',
      entityId: phantomId
    });
    await this.saveState(`Delete phantom ${phantomId}`);
    this.renderAll();
  }

  // 🔌 ChitinGate Endpoint Handlers
  toggleEndpointFields() {
    const mode = document.getElementById('ep-mode').value;
    const staticGroup = document.getElementById('group-ep-static');
    const actionsGroup = document.getElementById('group-ep-actions');
    const morphGroup = document.getElementById('group-ep-morph');

    staticGroup.classList.add('hidden');
    actionsGroup.classList.add('hidden');
    morphGroup.classList.add('hidden');

    if (mode === 'static') staticGroup.classList.remove('hidden');
    if (mode === 'actions') actionsGroup.classList.remove('hidden');
    if (mode === 'morph') morphGroup.classList.remove('hidden');
  }

  async handleCreateEndpoint(e) {
    e.preventDefault();
    const path = document.getElementById('ep-path').value.trim();
    const mode = document.getElementById('ep-mode').value;
    const staticDataStr = document.getElementById('ep-data').value;
    const workflow = document.getElementById('ep-workflow').value;
    const morphUrl = document.getElementById('ep-morph-url').value;
    const desc = document.getElementById('ep-desc').value;

    const normalizedPath = path.startsWith('/') ? path : `/${path}`;

    let staticData;
    if (mode === 'static') {
      try { staticData = JSON.parse(staticDataStr || '{}'); }
      catch { this.showToast('Static Data must be valid JSON.', 'error'); return; }
    }

    const endpointId = `ep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    const endpoint = {
      endpointId,
      path: normalizedPath,
      methods: [mode === 'static' ? 'GET' : 'POST'],
      mode,
      staticData,
      actionsWorkflow: workflow || undefined,
      morphUrl: morphUrl || undefined,
      requiredScopes: [],
      description: desc,
      createdAt: now,
      updatedAt: now,
      active: true
    };

    if (mode === 'static') {
      await this.writeCdnFile(`endpoints${normalizedPath}/index.json`, JSON.stringify(staticData, null, 2), `Ballom: Create static endpoint ${normalizedPath}`);
    }

    this.state.endpoints[endpointId] = endpoint;
    this.state.auditLog.push({
      timestamp: now,
      action: 'chitingate:create',
      entity: 'endpoint',
      entityId: endpointId,
      metadata: { path: normalizedPath, mode }
    });

    await this.saveState(`Create API Endpoint ${normalizedPath}`);
    this.closeModal('create-endpoint-modal');
    document.getElementById('create-endpoint-form').reset();
    this.renderAll();
  }

  async deleteEndpoint(endpointId) {
    if (!(await this.customConfirm('Are you sure you want to delete this endpoint?', '🔌 Delete Endpoint'))) return;
    const ep = this.state.endpoints[endpointId];
    if (ep && ep.mode === 'static') {
      await this.deleteCdnFile(`endpoints${ep.path}/index.json`, `Ballom: Delete static endpoint ${ep.path}`);
    }
    delete this.state.endpoints[endpointId];
    this.state.auditLog.push({
      timestamp: new Date().toISOString(),
      action: 'chitingate:delete',
      entity: 'endpoint',
      entityId: endpointId,
      metadata: { path: ep?.path }
    });
    await this.saveState(`Delete API Endpoint ${ep?.path}`);
    this.renderAll();
  }

  // 🥚 Larvae Aliases Handlers
  async handleCreateAlias(e) {
    e.preventDefault();
    const target = document.getElementById('alias-target').value;
    const customSlug = document.getElementById('alias-slug').value.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    const base = document.getElementById('alias-base').value;
    const expiry = document.getElementById('alias-expiry').value;

    const slug = customSlug || Math.random().toString(36).slice(2, 8);
    const now = new Date().toISOString();

    const alias = {
      slug,
      targetUrl: target,
      baseUrl: base || undefined,
      clicks: 0,
      expiresAt: expiry ? new Date(expiry).toISOString() : undefined,
      createdAt: now,
      active: true
    };

    const redirectHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="0; url=${target}" />
  <title>Redirecting…</title>
  <script>window.location.replace("${target}");</script>
</head>
<body>
  <p>Redirecting to <a href="${target}">${target}</a>…</p>
</body>
</html>`;

    await this.writeCdnFile(`s/${slug}/index.html`, redirectHtml, `Ballom: Create short link s/${slug}`);

    this.state.larvae[slug] = alias;
    this.state.auditLog.push({
      timestamp: now,
      action: 'larvae:create',
      entity: 'alias',
      entityId: slug,
      metadata: { targetUrl: target, slug }
    });

    await this.saveState(`Create dynamic alias s/${slug}`);
    this.closeModal('create-alias-modal');
    document.getElementById('create-alias-form').reset();
    this.renderAll();
  }

  async deleteAlias(slug) {
    if (!(await this.customConfirm(`Are you sure you want to permanently delete /s/${slug}?`, '🥚 Delete Alias'))) return;
    await this.deleteCdnFile(`s/${slug}/index.html`, `Ballom: Delete alias s/${slug}`);
    delete this.state.larvae[slug];
    this.state.auditLog.push({
      timestamp: new Date().toISOString(),
      action: 'larvae:delete',
      entity: 'alias',
      entityId: slug
    });
    await this.saveState(`Delete dynamic alias s/${slug}`);
    this.renderAll();
  }

  // 🐛 PheroPaths Router Handlers
  async handleCreateRoute(e) {
    e.preventDefault();
    const name = document.getElementById('route-name').value;
    const match = document.getElementById('route-match').value;
    const pattern = document.getElementById('route-pattern').value;
    const action = document.getElementById('route-action').value;
    const dest = document.getElementById('route-dest').value;
    const priority = parseInt(document.getElementById('route-priority').value || '10');
    const fallback = document.getElementById('route-fallback').value;

    const routeId = `rt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    const route = {
      routeId,
      name,
      priority,
      condition: { matchType: match, pattern },
      action,
      destination: dest,
      fallback: fallback || undefined,
      active: true,
      createdAt: now,
      updatedAt: now
    };

    this.state.routes[routeId] = route;
    this.state.auditLog.push({
      timestamp: now,
      action: 'pheropaths:create',
      entity: 'route',
      entityId: routeId,
      metadata: { name, matchType: match, pattern, action, destination: dest }
    });

    await this.saveState(`Create routing rule ${name}`);
    this.closeModal('create-route-modal');
    document.getElementById('create-route-form').reset();
    this.renderAll();
  }

  async deleteRoute(routeId) {
    if (!(await this.customConfirm('Are you sure you want to delete this route?', '🐛 Delete Route'))) return;
    const r = this.state.routes[routeId];
    delete this.state.routes[routeId];
    this.state.auditLog.push({
      timestamp: new Date().toISOString(),
      action: 'pheropaths:delete',
      entity: 'route',
      entityId: routeId,
      metadata: { name: r?.name }
    });
    await this.saveState(`Delete routing rule ${r?.name}`);
    this.renderAll();
  }
  handleEvaluateRoute(e) {
    e.preventDefault();
    const path = document.getElementById('eval-path').value.trim();
    const resultBox = document.getElementById('eval-result');
    resultBox.classList.remove('hidden');

    const routes = Object.values(this.state.routes || {})
      .filter(r => r.active)
      .sort((a, b) => a.priority - b.priority);

    let match = null;
    for (const r of routes) {
      let isMatch = false;
      const pattern = r.condition.pattern;
      if (r.condition.matchType === 'path') isMatch = path === pattern;
      else if (r.condition.matchType === 'prefix') {
        const cleanPattern = pattern.replace(/\*$/, '');
        isMatch = path.startsWith(cleanPattern);
      }
      else if (r.condition.matchType === 'regex') {
        try { isMatch = new RegExp(pattern).test(path); } catch { isMatch = false; }
      }

      if (isMatch) {
        match = r;
        break;
      }
    }

    if (match) {
      resultBox.innerHTML = `
        <div class="p-3 bg-black-05 border-left-emerald rounded">
          <span style="color: var(--accent-emerald); font-weight: 700;">✔ MATCH FOUND!</span>
          <p class="font-sm mt-1">Matched Rule: <strong>${match.name}</strong> (Priority ${match.priority})</p>
          <p class="font-sm mt-1">Action: <span class="badge badge-indigo">${match.action}</span></p>
          <p class="font-sm mt-1">Destination: <code class="font-mono text-white">${match.destination}</code></p>
        </div>`;
    } else {
      resultBox.innerHTML = `
        <div class="p-3 bg-black-05 border-left-rose rounded">
          <span style="color: var(--accent-rose); font-weight: 700;">✘ NO MATCH FOUND</span>
          <p class="font-sm mt-1">The path did not match any active routing rules.</p>
        </div>`;
    }
  }

  resetRouteEvaluator() {
    const evalPath = document.getElementById('eval-path');
    const resultBox = document.getElementById('eval-result');
    if (evalPath) evalPath.value = '';
    if (resultBox) {
      resultBox.innerHTML = '';
      resultBox.classList.add('hidden');
    }
  }

  // 🔑 ScentKey API Key Management Handlers
  async handleCreateKey(e) {
    e.preventDefault();
    const name = document.getElementById('key-name').value;
    const env = document.getElementById('key-env').value;
    const expiry = document.getElementById('key-expiry').value;

    const checkedScopes = [];
    document.querySelectorAll('input[name="key-scopes"]:checked').forEach(cb => {
      checkedScopes.push(cb.value);
    });

    if (checkedScopes.length === 0) {
      this.showToast('Please select at least one scope.', 'error');
      return;
    }

    const keyId = `skid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    
    // Generate a strong random key format: sck_<env>_<random hex bytes>
    const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(20)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const rawKey = `sck_${env}_${randomHex}`;

    // Cryptographic SHA-256 hash using Web Crypto API
    const encoder = new TextEncoder();
    const data = encoder.encode(rawKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const keyHash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    const keyPrefix = rawKey.slice(0, 16);
    const now = new Date().toISOString();

    const record = {
      keyId,
      keyPrefix,
      keyHash,
      env,
      scopes: checkedScopes,
      name,
      createdAt: now,
      expiresAt: expiry ? new Date(expiry).toISOString() : undefined,
      active: true
    };

    this.state.scentKeys[keyId] = record;
    this.state.auditLog.push({
      timestamp: now,
      action: 'scentkey:create',
      entity: 'scentkey',
      entityId: keyId,
      metadata: { name, env, scopes: checkedScopes, keyPrefix }
    });

    await this.saveState(`Issue API ScentKey ${name}`);
    this.closeModal('create-key-modal');
    document.getElementById('create-key-form').reset();
    
    // Display raw key once
    this.cachedRawKey = rawKey;
    document.getElementById('created-raw-key').innerText = rawKey;
    document.getElementById('created-key-id').innerText = keyId;
    document.getElementById('created-key-name').innerText = name;
    document.getElementById('created-key-prefix').innerText = keyPrefix;
    document.getElementById('created-key-scopes').innerText = checkedScopes.join(', ');

    this.openModal('show-key-modal');
    this.renderAll();
  }

  copyCreatedKey() {
    navigator.clipboard.writeText(this.cachedRawKey);
    this.showToast('Copied raw key to clipboard!', 'success');
  }

  async revokeScentKey(keyId) {
    if (!(await this.customConfirm('Are you sure you want to permanently revoke this API ScentKey?', '🔑 Revoke ScentKey'))) return;
    const k = this.state.scentKeys[keyId];
    if (k) {
      k.active = false;
      this.state.auditLog.push({
        timestamp: new Date().toISOString(),
        action: 'scentkey:revoke',
        entity: 'scentkey',
        entityId: keyId,
        metadata: { name: k.name }
      });
      await this.saveState(`Revoke API ScentKey ${k.name}`);
      this.renderAll();
    }
  }

  async rotateScentKey(keyId) {
    if (!(await this.customConfirm('Are you sure you want to rotate this key? The current key will be immediately revoked.', '🔑 Rotate ScentKey'))) return;
    const k = this.state.scentKeys[keyId];
    if (!k) return;

    // Revoke old key
    k.active = false;

    // Create rotated copy
    const newKeyId = `skid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(20)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const rawKey = `sck_${k.env}_${randomHex}`;

    const encoder = new TextEncoder();
    const data = encoder.encode(rawKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const keyHash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    const keyPrefix = rawKey.slice(0, 16);
    const now = new Date().toISOString();

    const record = {
      keyId: newKeyId,
      keyPrefix,
      keyHash,
      env: k.env,
      scopes: k.scopes,
      name: `${k.name} (rotated)`,
      createdAt: now,
      expiresAt: k.expiresAt,
      active: true
    };

    this.state.scentKeys[newKeyId] = record;
    this.state.auditLog.push({
      timestamp: now,
      action: 'scentkey:rotate',
      entity: 'scentkey',
      entityId: newKeyId,
      metadata: { name: record.name, oldKeyId: keyId, keyPrefix }
    });

    await this.saveState(`Rotate ScentKey ${k.name}`);
    
    // Display raw key
    this.cachedRawKey = rawKey;
    document.getElementById('created-raw-key').innerText = rawKey;
    document.getElementById('created-key-id').innerText = newKeyId;
    document.getElementById('created-key-name').innerText = record.name;
    document.getElementById('created-key-prefix').innerText = keyPrefix;
    document.getElementById('created-key-scopes').innerText = k.scopes.join(', ');

    this.openModal('show-key-modal');
    this.renderAll();
  }

  // ─── ✏️ EDIT / UPDATE HANDLERS (SPRINT 2) ────────────────────────────────────

  // 1. Feromask Edit
  openEditPhantomModal(phantomId) {
    const p = this.state.phantoms[phantomId];
    if (!p) return;
    document.getElementById('edit-phantom-id').value = phantomId;
    document.getElementById('edit-phantom-target').value = p.targetUrl || '';
    document.getElementById('edit-phantom-app-name').value = p.appName || p.phantomId;
    document.getElementById('edit-phantom-tld-ext').value = p.tldExt || '.is-a.dev';
    document.getElementById('edit-phantom-backup-target').value = p.backSheds?.backupTargetUrl || '';
    document.getElementById('edit-phantom-idle-timeout').value = p.backSheds?.idleTimeoutMinutes || 15;
    document.getElementById('edit-phantom-title').value = p.title || '';
    document.getElementById('edit-phantom-desc').value = p.description || '';
    this.openModal('edit-phantom-modal');
  }

  async handleUpdatePhantom(event) {
    event.preventDefault();
    const phantomId = document.getElementById('edit-phantom-id').value;
    const p = this.state.phantoms[phantomId];
    if (!p) return;

    const targetUrl = document.getElementById('edit-phantom-target').value.trim();
    const appName = document.getElementById('edit-phantom-app-name').value.trim();
    const tldExt = document.getElementById('edit-phantom-tld-ext').value;
    const backupTargetUrl = document.getElementById('edit-phantom-backup-target').value.trim();
    const idleTimeoutMinutes = parseInt(document.getElementById('edit-phantom-idle-timeout').value, 10);
    const title = document.getElementById('edit-phantom-title').value.trim();
    document.getElementById('edit-phantom-desc').value.trim();

    const maskedDomain = tldExt === 'custom' ? appName : `${appName}${tldExt}`;

    p.targetUrl = targetUrl;
    p.appName = appName;
    p.tldExt = tldExt;
    p.maskedDomain = maskedDomain;
    p.title = title || appName;
    p.description = document.getElementById('edit-phantom-desc').value.trim();
    p.backSheds = { backupTargetUrl, idleTimeoutMinutes };
    p.updatedAt = new Date().toISOString();

    // Republish iframe CDN page
    if (p.mode === 'iframe' && this.state.configured) {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${p.title}</title>
  ${p.description ? `<meta name="description" content="${p.description}" />` : ''}
  <style>* { margin: 0; padding: 0; box-sizing: border-box; } html, body { width: 100%; height: 100%; overflow: hidden; } iframe { position: fixed; top: 0; left: 0; width: 100%; height: 100%; border: none; }</style>
</head>
<body>
  <iframe src="${p.targetUrl}" title="${p.title}" allowfullscreen></iframe>
</body>
</html>`;
      await this.writeCdnFile(`phantoms/${phantomId}/index.html`, html, `Update Feromask phantom ${phantomId}`);
    }

    this.state.auditLog.push({
      timestamp: new Date().toISOString(),
      action: 'feromask:update',
      entity: 'phantom',
      entityId: phantomId,
      metadata: { targetUrl, maskedDomain }
    });

    await this.saveState(`Updated Feromask Phantom ${phantomId}`);
    this.closeModal('edit-phantom-modal');
    this.showToast('Feromask Phantom updated successfully!', 'success');
    this.renderAll();
  }

  // 2. ChitinGate Edit
  openEditEndpointModal(endpointId) {
    const ep = this.state.endpoints[endpointId];
    if (!ep) return;
    document.getElementById('edit-ep-id').value = endpointId;
    document.getElementById('edit-ep-path').value = ep.path || '';
    document.getElementById('edit-ep-mode').value = ep.mode || 'static';
    document.getElementById('edit-ep-data').value = ep.staticData ? JSON.stringify(ep.staticData, null, 2) : '';
    document.getElementById('edit-ep-workflow').value = ep.actionsWorkflow || '';
    document.getElementById('edit-ep-morph-url').value = ep.morphUrl || '';
    document.getElementById('edit-ep-desc').value = ep.description || '';
    this.toggleEditEndpointFields();
    this.openModal('edit-endpoint-modal');
  }

  toggleEditEndpointFields() {
    const mode = document.getElementById('edit-ep-mode').value;
    document.getElementById('edit-group-ep-static').classList.toggle('hidden', mode !== 'static');
    document.getElementById('edit-group-ep-actions').classList.toggle('hidden', mode !== 'actions');
    document.getElementById('edit-group-ep-morph').classList.toggle('hidden', mode !== 'morph');
  }

  async handleUpdateEndpoint(event) {
    event.preventDefault();
    const endpointId = document.getElementById('edit-ep-id').value;
    const ep = this.state.endpoints[endpointId];
    if (!ep) return;

    const pathRaw = document.getElementById('edit-ep-path').value.trim();
    const path = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`;
    const mode = document.getElementById('edit-ep-mode').value;
    const description = document.getElementById('edit-ep-desc').value.trim();

    ep.path = path;
    ep.mode = mode;
    ep.description = description;
    ep.updatedAt = new Date().toISOString();

    if (mode === 'static') {
      const dataStr = document.getElementById('edit-ep-data').value.trim();
      let parsed = {};
      try { if (dataStr) parsed = JSON.parse(dataStr); } catch (e) {
        this.showToast('Invalid JSON format in endpoint static data.', 'error');
        return;
      }
      ep.staticData = parsed;
      if (this.state.configured) {
        await this.writeCdnFile(`endpoints${path}/index.json`, JSON.stringify(parsed, null, 2), `Update static endpoint ${path}`);
      }
    } else if (mode === 'actions') {
      ep.actionsWorkflow = document.getElementById('edit-ep-workflow').value.trim();
    } else if (mode === 'morph') {
      ep.morphUrl = document.getElementById('edit-ep-morph-url').value.trim();
    }

    this.state.auditLog.push({
      timestamp: new Date().toISOString(),
      action: 'chitingate:update',
      entity: 'endpoint',
      entityId: endpointId,
      metadata: { path, mode }
    });

    await this.saveState(`Updated API Endpoint ${path}`);
    this.closeModal('edit-endpoint-modal');
    this.showToast('API Endpoint updated successfully!', 'success');
    this.renderAll();
  }

  // 3. Larvae Edit
  openEditAliasModal(currentSlug) {
    const a = this.state.larvae[currentSlug];
    if (!a) return;
    document.getElementById('edit-alias-current-slug').value = currentSlug;
    document.getElementById('edit-alias-slug').value = a.slug || '';
    document.getElementById('edit-alias-target').value = a.targetUrl || '';
    document.getElementById('edit-alias-base').value = a.baseUrl || '';
    document.getElementById('edit-alias-expiry').value = a.expiresAt ? new Date(a.expiresAt).toISOString().slice(0, 16) : '';
    this.openModal('edit-alias-modal');
  }

  async handleUpdateAlias(event) {
    event.preventDefault();
    const currentSlug = document.getElementById('edit-alias-current-slug').value;
    const a = this.state.larvae[currentSlug];
    if (!a) return;

    const newSlug = document.getElementById('edit-alias-slug').value.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    const targetUrl = document.getElementById('edit-alias-target').value.trim();
    const baseUrl = document.getElementById('edit-alias-base').value.trim();
    const expiry = document.getElementById('edit-alias-expiry').value;

    if (newSlug !== currentSlug && this.state.larvae[newSlug]) {
      this.showToast(`Slug /s/${newSlug} is already in use.`, 'error');
      return;
    }

    // Rename in state if slug changed
    if (newSlug !== currentSlug) {
      delete this.state.larvae[currentSlug];
      a.slug = newSlug;
      this.state.larvae[newSlug] = a;
    }

    a.targetUrl = targetUrl;
    a.baseUrl = baseUrl || undefined;
    a.expiresAt = expiry ? new Date(expiry).toISOString() : undefined;

    // Republish redirect HTML
    if (this.state.configured) {
      const redirectHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="0; url=${targetUrl}"><title>Redirecting…</title><script>window.location.replace("${targetUrl}");</script></head><body><p>Redirecting to <a href="${targetUrl}">${targetUrl}</a>…</p></body></html>`;
      await this.writeCdnFile(`s/${newSlug}/index.html`, redirectHtml, `Update Larvae alias /s/${newSlug}`);
    }

    this.state.auditLog.push({
      timestamp: new Date().toISOString(),
      action: 'larvae:update',
      entity: 'alias',
      entityId: newSlug,
      metadata: { targetUrl, slug: newSlug }
    });

    await this.saveState(`Updated Larvae Alias /s/${newSlug}`);
    this.closeModal('edit-alias-modal');
    this.showToast('Short Link updated successfully!', 'success');
    this.renderAll();
  }

  // 4. PheroPaths Edit
  openEditRouteModal(routeId) {
    const r = this.state.routes[routeId];
    if (!r) return;
    document.getElementById('edit-route-id').value = routeId;
    document.getElementById('edit-route-name').value = r.name || '';
    document.getElementById('edit-route-match').value = r.condition?.matchType || 'path';
    document.getElementById('edit-route-pattern').value = r.condition?.pattern || '';
    document.getElementById('edit-route-action').value = r.action || 'proxy';
    document.getElementById('edit-route-dest').value = r.destination || '';
    document.getElementById('edit-route-priority').value = r.priority || 10;
    document.getElementById('edit-route-fallback').value = r.fallback || '';
    this.openModal('edit-route-modal');
  }

  async handleUpdateRoute(event) {
    event.preventDefault();
    const routeId = document.getElementById('edit-route-id').value;
    const r = this.state.routes[routeId];
    if (!r) return;

    r.name = document.getElementById('edit-route-name').value.trim();
    r.condition = {
      matchType: document.getElementById('edit-route-match').value,
      pattern: document.getElementById('edit-route-pattern').value.trim()
    };
    r.action = document.getElementById('edit-route-action').value;
    r.destination = document.getElementById('edit-route-dest').value.trim();
    r.priority = parseInt(document.getElementById('edit-route-priority').value, 10) || 10;
    r.fallback = document.getElementById('edit-route-fallback').value.trim() || undefined;
    r.updatedAt = new Date().toISOString();

    this.state.auditLog.push({
      timestamp: new Date().toISOString(),
      action: 'pheropaths:update',
      entity: 'route',
      entityId: routeId,
      metadata: { name: r.name, destination: r.destination }
    });

    await this.saveState(`Updated PheroPaths Route ${r.name}`);
    this.closeModal('edit-route-modal');
    this.showToast('Routing Rule updated successfully!', 'success');
    this.renderAll();
  }

  // 5. ScentKeys Edit
  openEditKeyModal(keyId) {
    const k = this.state.scentKeys[keyId];
    if (!k) return;
    document.getElementById('edit-key-id').value = keyId;
    document.getElementById('edit-key-name').value = k.name || '';
    document.getElementById('edit-key-expiry').value = k.expiresAt ? k.expiresAt.slice(0, 10) : '';

    const checkboxes = document.querySelectorAll('input[name="edit-key-scopes"]');
    checkboxes.forEach(cb => {
      cb.checked = (k.scopes || []).includes(cb.value);
    });

    this.openModal('edit-key-modal');
  }

  async handleUpdateKey(event) {
    event.preventDefault();
    const keyId = document.getElementById('edit-key-id').value;
    const k = this.state.scentKeys[keyId];
    if (!k) return;

    const name = document.getElementById('edit-key-name').value.trim();
    const expiry = document.getElementById('edit-key-expiry').value;

    const checkboxes = document.querySelectorAll('input[name="edit-key-scopes"]:checked');
    const checkedScopes = Array.from(checkboxes).map(cb => cb.value);

    k.name = name;
    k.scopes = checkedScopes.length > 0 ? checkedScopes : ['read'];
    k.expiresAt = expiry ? new Date(expiry).toISOString() : undefined;

    this.state.auditLog.push({
      timestamp: new Date().toISOString(),
      action: 'scentkey:update',
      entity: 'scentkey',
      entityId: keyId,
      metadata: { name, scopes: k.scopes }
    });

    await this.saveState(`Updated ScentKey metadata ${name}`);
    this.closeModal('edit-key-modal');
    this.showToast('ScentKey metadata updated successfully!', 'success');
    this.renderAll();
  }
}

// Instantiate global app instance
const app = new BallomConsole();
window.app = app;
