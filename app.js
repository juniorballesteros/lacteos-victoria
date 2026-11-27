// Importar los SDKs necesarios de Firebase (versión modular 13.2.0)
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import { getDatabase, ref, set, get, update, onValue } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-database.js";

// Credenciales oficiales de tu proyecto en Firebase
const firebaseConfig = {
    apiKey: "AIzaSyAXWC6FgkeLlOtzH4_gPTwkRQzKrbAPCkE",
    authDomain: "lacteosvictoria-2b574.firebaseapp.com",
    databaseURL: "https://lacteosvictoria-2b574-default-rtdb.firebaseio.com",
    projectId: "lacteosvictoria-2b574",
    storageBucket: "lacteosvictoria-2b574.appfirebasestorage.app",
    messagingSenderId: "1010099938727",
    appId: "1:1010099938727:web:4ad61b1e0ae7cb98768282",
    measurementId: "G-NB2W7V2TGB"
};

// Inicializar Firebase y Base de Datos
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Claves de almacenamiento en Firebase
const DEFAULT_STORAGE_KEY = 'lacteos_app_master_db';
const USERS_REGISTRY_KEY = 'lacteos_users_registry';
const LOCAL_USERS_CACHE_KEY = 'lacteos_local_users_cache_v4';
const PRIMARY_OWNER_EMAIL = 'ballesterosjunior3@gmail.com';


// ---------- Utilidades de seguridad y fechas ----------
function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toISODate(raw) {
    const str = String(raw || '').trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(str);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return '';
}

function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, salt) {
    if (!window.crypto || !window.crypto.subtle) {
        throw new Error('El navegador no permite cifrar contraseñas. Abre la app desde https:// o localhost.');
    }
    const data = new TextEncoder().encode(`${salt}:${password}`);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return bytesToHex(new Uint8Array(digest));
}

async function buildPasswordFields(password) {
    const saltBytes = new Uint8Array(16);
    crypto.getRandomValues(saltBytes);
    const salt = bytesToHex(saltBytes);
    return { salt, passwordHash: await hashPassword(password, salt) };
}

// Devuelve true si la clave es correcta. Migra cuentas antiguas (clave en texto plano) a hash.
async function verifyAndUpgradePassword(userRecord, password) {
    if (userRecord.passwordHash && userRecord.salt) {
        return (await hashPassword(password, userRecord.salt)) === userRecord.passwordHash;
    }
    if (userRecord.password !== undefined && userRecord.password === password) {
        const fields = await buildPasswordFields(password);
        userRecord.salt = fields.salt;
        userRecord.passwordHash = fields.passwordHash;
        delete userRecord.password;
        await persistRegisteredUser(userRecord);
        return true;
    }
    return false;
}

let currentWorkspaceKey = null;
let unsubscribeWorkspaceListener = null;

const SYNC_KEYS = ['companyName', 'clients', 'products', 'productionLogs', 'salesHistory', 'expenses',
    'milkProviders', 'dailyMilkLogs', 'milkPayments', 'yieldLogs', 'clientDebts'];
let lastSyncedJSON = {};

// ---------- Sesión persistente: dura hasta la medianoche (hora local) ----------
const SESSION_KEY = 'lacteos_session_v1';
let sessionExpiresAt = 0;

function endOfTodayMs() {
    const d = new Date();
    d.setHours(24, 0, 0, 0);
    return d.getTime();
}

function saveSession(email, expiresAt) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ email, expiresAt })); } catch (_) {}
}

function clearSession() {
    sessionExpiresAt = 0;
    try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
}

function readValidSession() {
    try {
        const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
        if (saved && saved.email && saved.expiresAt > Date.now()) return saved;
    } catch (_) {}
    clearSession();
    return null;
}

async function restoreSession() {
    const saved = readValidSession();
    if (!saved) return;
    try {
        const user = await fetchRegisteredUser(saved.email);
        if (!user) { clearSession(); return; }
        enterAuthenticatedSession(user, saved.expiresAt);
    } catch (err) {
        console.warn("No se pudo restaurar la sesión:", err);
    }
}

// Si la app estuvo en segundo plano y ya pasó la medianoche, vuelve a pedir correo y clave
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (sessionExpiresAt && Date.now() >= sessionExpiresAt) {
        logout();
        alert("🔒 Tu sesión del día terminó. Ingresa de nuevo con tu correo y contraseña.");
    }
});

function snapshotSyncState() {
    SYNC_KEYS.forEach(k => { lastSyncedJSON[k] = JSON.stringify(state[k] ?? null); });
}

function createEmptyAppState() {
    return {
        companyName: 'Lácteos Victoria',
        currentUserRole: 'admin',
        currentUserEmail: null,
        clients: [],
        products: [],
        productionLogs: [],
        salesHistory: [],
        expenses: [],
        milkProviders: [],
        dailyMilkLogs: [],
        milkPayments: [],
        yieldLogs: [],
        clientDebts: [],
        cart: []
    };
}

// ESTADO GENERAL DE LA APLICACIÓN
let state = createEmptyAppState();

let currentDayMilkData = { totalLiters: 0, totalCost: 0, avgCostPerLiter: 0, remainingLiters: 0 };
let expandedDebtIds = new Set();
let isRegisterMode = false;
let lastReceiptData = null;

function getLocalDateString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function emailToFirebaseKey(email) {
    return email.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
}

function getOwnerWorkspaceKey(ownerEmail) {
    const cleanEmail = (ownerEmail || '').trim().toLowerCase();
    if (cleanEmail === PRIMARY_OWNER_EMAIL) {
        return DEFAULT_STORAGE_KEY;
    }
    return `lacteos_owner_${emailToFirebaseKey(cleanEmail)}`;
}

function resolveWorkspaceForOwner(email, companyName) {
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanCompany = (companyName || '').trim();

    if (cleanEmail === PRIMARY_OWNER_EMAIL) {
        return {
            workspaceKey: DEFAULT_STORAGE_KEY,
            resolvedCompanyName: cleanCompany || 'Lácteos Victoria'
        };
    }

    // Cada correo de dueño distinto obtiene su propia base de datos única e independiente,
    // sin importar si dos dueños escriben el mismo nombre de empresa.
    return {
        workspaceKey: getOwnerWorkspaceKey(cleanEmail),
        resolvedCompanyName: cleanCompany || 'Mi Empresa Láctea'
    };
}

function getLocalUsersCache() {
    try {
        return JSON.parse(localStorage.getItem(LOCAL_USERS_CACHE_KEY) || '{}');
    } catch (_) {
        return {};
    }
}

function saveUserToLocalCache(emailKey, userRecord) {
    try {
        const cache = getLocalUsersCache();
        cache[emailKey] = userRecord;
        localStorage.setItem(LOCAL_USERS_CACHE_KEY, JSON.stringify(cache));
    } catch (err) {
        console.warn("No se pudo guardar respaldo local de usuario:", err);
    }
}

async function fetchRegisteredUser(email) {
    const emailKey = emailToFirebaseKey(email);
    try {
        const snap = await get(ref(db, `${USERS_REGISTRY_KEY}/${emailKey}`));
        if (snap.exists()) {
            const userData = snap.val();
            saveUserToLocalCache(emailKey, userData);
            return userData;
        }
    } catch (err) {
        console.warn("Consultando respaldo local por fallo de red en registro:", err);
    }
    const localCache = getLocalUsersCache();
    return localCache[emailKey] || null;
}

async function persistRegisteredUser(userRecord) {
    const emailKey = emailToFirebaseKey(userRecord.email);
    saveUserToLocalCache(emailKey, userRecord);
    await set(ref(db, `${USERS_REGISTRY_KEY}/${emailKey}`), userRecord);
}

function refreshAllVisibleTables() {
    const appNameEl = document.getElementById('app-company-name');
    const receiptCompanyEl = document.getElementById('receipt-company');
    if (appNameEl) appNameEl.innerText = state.companyName;
    if (receiptCompanyEl) receiptCompanyEl.innerText = state.companyName.toUpperCase();

    if (document.getElementById('main-app') && !document.getElementById('main-app').classList.contains('hidden')) {
        renderClientSelect();
        renderPastDebtClientSelect();
        renderProductsPOS();
        renderInventoryTable();
        renderProductionHistory();
        renderSalesHistory();
        renderExpensesTable();
        renderMilkProvidersSelect();
        renderProvidersTable();
        renderMilkPaymentsTable();
        renderDailyMilkTable();
        renderYieldTable();
        renderMonthlyBalance();
        renderClientAccountsTable();
        const yieldForm = document.getElementById('yield-form');
        if (!(yieldForm && yieldForm.contains(document.activeElement))) {
            onYieldDateChange();
            onYieldProductSelectChange();
        }
    }
}

function subscribeToWorkspace(workspaceKey, accountRecord) {
    if (unsubscribeWorkspaceListener) {
        unsubscribeWorkspaceListener();
        unsubscribeWorkspaceListener = null;
    }

    currentWorkspaceKey = workspaceKey;
    const dbRef = ref(db, workspaceKey);

    unsubscribeWorkspaceListener = onValue(dbRef, (snapshot) => {
        const parsed = snapshot.val();
        if (parsed) {
            let resolvedName = parsed.companyName || accountRecord.companyName || 'Lácteos Victoria';
            // Restaurar el nombre oficial de Lácteos Victoria si una prueba anterior lo sobrescribió
            if (workspaceKey === DEFAULT_STORAGE_KEY && resolvedName.trim().toLowerCase() === 'pipe') {
                resolvedName = 'Lácteos Victoria';
                set(ref(db, `${DEFAULT_STORAGE_KEY}/companyName`), 'Lácteos Victoria').catch(() => {});
            }

            state.companyName = resolvedName;
            state.clients = parsed.clients || [];
            state.products = parsed.products || [];
            state.productionLogs = parsed.productionLogs || [];
            state.salesHistory = parsed.salesHistory || [];
            state.expenses = parsed.expenses || [];
            state.milkProviders = parsed.milkProviders || [];
            state.dailyMilkLogs = parsed.dailyMilkLogs || [];
            state.milkPayments = parsed.milkPayments || [];
            state.yieldLogs = parsed.yieldLogs || [];
            state.clientDebts = (parsed.clientDebts || []).map(d => {
                const iso = toISODate(d.date);
                return iso && iso !== d.date ? { ...d, date: iso } : d;
            });
            snapshotSyncState();
        } else {
            // Espacio de trabajo nuevo e independiente (sin compartir datos de otras cuentas)
            const fresh = createEmptyAppState();
            fresh.companyName = accountRecord.companyName || 'Mi Empresa Láctea';
            fresh.currentUserRole = accountRecord.role || 'admin';
            fresh.currentUserEmail = accountRecord.email;
            state = fresh;
            lastSyncedJSON = {};
            saveData();
        }

        refreshAllVisibleTables();
    });
}

function saveData() {
    if (!currentWorkspaceKey) return;

    // Solo se escriben las colecciones que cambiaron. Así el conductor (leche) y el dueño
    // no se sobrescriben entre sí cuando trabajan al mismo tiempo en colecciones distintas.
    const changes = {};
    SYNC_KEYS.forEach(k => {
        const json = JSON.stringify(state[k] ?? null);
        if (json !== lastSyncedJSON[k]) {
            changes[k] = state[k] ?? null;
            lastSyncedJSON[k] = json;
        }
    });
    if (Object.keys(changes).length === 0) return;

    update(ref(db, currentWorkspaceKey), changes).catch((error) => {
        console.error("Error al sincronizar con Firebase:", error);
        alert("⚠️ No se pudo guardar en la nube. Revisa tu conexión: el último cambio podría no haberse guardado.");
    });
}

document.addEventListener('DOMContentLoaded', () => {
    if (window.lucide) lucide.createIcons();
    updateDateDisplay();

    const titleEl = document.getElementById('display-company-title');
    if (titleEl) titleEl.innerText = 'Lácteos Victoria';

    const pastDebtDateEl = document.getElementById('past-debt-date');
    if (pastDebtDateEl) pastDebtDateEl.value = getLocalDateString();

    restoreSession();
});

function updateDateDisplay() {
    const now = new Date();
    const dateEl = document.getElementById('current-date');
    if (dateEl) dateEl.innerText = now.toLocaleDateString('es-CO');
}

function handleRegisterRoleChange() {
    const roleSelect = document.getElementById('user-role-input');
    const companyLabel = document.getElementById('company-name-label');
    const companyInput = document.getElementById('company-name-input');
    const companyHint = document.getElementById('company-name-hint');
    if (!roleSelect) return;

    if (roleSelect.value === 'conductor') {
        if (companyLabel) companyLabel.innerText = 'Correo del Dueño de la Empresa';
        if (companyInput) {
            companyInput.type = 'email';
            companyInput.value = '';
            companyInput.placeholder = 'Ej: dueno@correo.com';
        }
        if (companyHint) companyHint.innerText = 'Escribe el correo con el que está registrado el dueño para conectarte solo a su módulo de Acopio de Leche.';
    } else {
        if (companyLabel) companyLabel.innerText = 'Nombre de tu Empresa / Quesera';
        if (companyInput) {
            companyInput.type = 'text';
            companyInput.value = '';
            companyInput.placeholder = 'Ej: Quesera El Prado';
        }
        if (companyHint) companyHint.innerText = 'Cada correo de dueño crea una empresa 100% independiente, sin importar el nombre que elijas.';
    }
}

function checkPasswordStrength(password) {
    const bar = document.getElementById('strength-bar');
    const label = document.getElementById('strength-label');
    if (!bar || !label) return;

    if (!password || password.length === 0) {
        bar.className = 'bg-red-500 h-full w-1/4 transition-all duration-300';
        label.className = 'text-red-500 font-bold';
        label.innerText = 'Débil';
        return;
    }

    let score = 0;
    if (password.length >= 6) score++;
    if (password.length >= 9) score++;
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;

    if (score <= 2) {
        bar.className = 'bg-red-500 h-full w-1/3 transition-all duration-300';
        label.className = 'text-red-500 font-bold';
        label.innerText = 'Débil';
    } else if (score <= 3) {
        bar.className = 'bg-amber-500 h-full w-2/3 transition-all duration-300';
        label.className = 'text-amber-600 font-bold';
        label.innerText = 'Media';
    } else {
        bar.className = 'bg-emerald-500 h-full w-full transition-all duration-300';
        label.className = 'text-emerald-600 font-bold';
        label.innerText = 'Fuerte';
    }
}

function switchAuthTab(mode) {
    isRegisterMode = mode === 'register';
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');
    const roleField = document.getElementById('role-selection-field');
    const companyField = document.getElementById('company-name-field');
    const companyInput = document.getElementById('company-name-input');
    const strengthContainer = document.getElementById('password-strength-container');
    const authBtn = document.getElementById('auth-btn');

    if (isRegisterMode) {
        if (tabRegister) tabRegister.className = "flex-1 py-2 text-sm font-bold rounded-lg transition-all bg-white text-emerald-800 shadow-sm";
        if (tabLogin) tabLogin.className = "flex-1 py-2 text-sm font-bold rounded-lg transition-all text-emerald-600 hover:text-emerald-900";
        if (roleField) roleField.classList.remove('hidden');
        if (companyField) companyField.classList.remove('hidden');
        if (companyInput) companyInput.required = true;
        if (strengthContainer) strengthContainer.classList.remove('hidden');
        if (authBtn) {
            authBtn.innerHTML = '<span>Crear Cuenta y Entrar</span><i data-lucide="user-plus" class="w-5 h-5"></i>';
        }
        handleRegisterRoleChange();
    } else {
        if (tabLogin) tabLogin.className = "flex-1 py-2 text-sm font-bold rounded-lg transition-all bg-white text-emerald-800 shadow-sm";
        if (tabRegister) tabRegister.className = "flex-1 py-2 text-sm font-bold rounded-lg transition-all text-emerald-600 hover:text-emerald-900";
        if (roleField) roleField.classList.add('hidden');
        if (companyField) companyField.classList.add('hidden');
        if (companyInput) companyInput.required = false;
        if (strengthContainer) strengthContainer.classList.add('hidden');
        if (authBtn) {
            authBtn.innerHTML = '<span>Ingresar al Sistema</span><i data-lucide="arrow-right" class="w-5 h-5"></i>';
        }
    }

    if (window.lucide) lucide.createIcons();
}

function enterAuthenticatedSession(accountRecord, restoredExpiresAt) {
    if (restoredExpiresAt) {
        sessionExpiresAt = restoredExpiresAt;
    } else {
        sessionExpiresAt = endOfTodayMs();
        saveSession(accountRecord.email, sessionExpiresAt);
    }
    state = createEmptyAppState();
    state.companyName = accountRecord.companyName || 'Lácteos Victoria';
    state.currentUserRole = accountRecord.role || 'admin';
    state.currentUserEmail = accountRecord.email;

    const appNameEl = document.getElementById('app-company-name');
    const receiptCompanyEl = document.getElementById('receipt-company');
    if (appNameEl) appNameEl.innerText = state.companyName;
    if (receiptCompanyEl) receiptCompanyEl.innerText = state.companyName.toUpperCase();

    subscribeToWorkspace(accountRecord.workspaceKey, accountRecord);

    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');

    applyUserRoleInterface();
    refreshAllVisibleTables();
    if (window.lucide) lucide.createIcons();
}

async function handleAuthSubmit(e) {
    e.preventDefault();
    const emailInput = document.getElementById('email-input');
    const passwordInput = document.getElementById('password-input');
    const authBtn = document.getElementById('auth-btn');

    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value.trim();
    if (!email || !password) return;

    const originalBtnHtml = authBtn ? authBtn.innerHTML : '';
    if (authBtn) {
        authBtn.disabled = true;
        authBtn.innerHTML = '<span>Verificando en la nube...</span>';
    }

    try {
        const existingUser = await fetchRegisteredUser(email);

        if (isRegisterMode) {
            if (existingUser) {
                alert("⚠️ Este correo ya está registrado. Cambia a la pestaña 'Iniciar Sesión' para ingresar con tu clave.");
                switchAuthTab('login');
                return;
            }

            const roleSelect = document.getElementById('user-role-input');
            const companyNameInput = document.getElementById('company-name-input');
            const role = roleSelect ? roleSelect.value : 'admin';
            const rawInput = companyNameInput ? companyNameInput.value.trim() : '';

            let workspaceKey = '';
            let resolvedCompanyName = '';
            let linkedOwnerEmail = null;

            if (role === 'conductor') {
                const ownerEmail = rawInput.toLowerCase();
                if (!ownerEmail) {
                    alert("⚠️ Escribe el correo del Dueño de la empresa donde trabajas.");
                    return;
                }

                if (ownerEmail === PRIMARY_OWNER_EMAIL) {
                    workspaceKey = DEFAULT_STORAGE_KEY;
                    resolvedCompanyName = 'Lácteos Victoria';
                    linkedOwnerEmail = PRIMARY_OWNER_EMAIL;
                } else {
                    const ownerUser = await fetchRegisteredUser(ownerEmail);
                    if (!ownerUser || ownerUser.role !== 'admin') {
                        alert("⚠️ No existe ningún Dueño registrado con ese correo. Verifica el correo del dueño e intenta de nuevo.");
                        return;
                    }
                    workspaceKey = getOwnerWorkspaceKey(ownerEmail);
                    resolvedCompanyName = ownerUser.companyName || 'Mi Empresa Láctea';
                    linkedOwnerEmail = ownerEmail;
                }
            } else {
                if (!rawInput && email !== PRIMARY_OWNER_EMAIL) {
                    alert("⚠️ Escribe el nombre de tu Empresa o Quesera para crear tu cuenta independiente.");
                    return;
                }
                const resolved = resolveWorkspaceForOwner(email, rawInput);
                workspaceKey = resolved.workspaceKey;
                resolvedCompanyName = resolved.resolvedCompanyName;
                linkedOwnerEmail = email;
            }

            const newAccount = {
                email,
                ...(await buildPasswordFields(password)),
                role,
                companyName: resolvedCompanyName,
                workspaceKey,
                ownerEmail: linkedOwnerEmail,
                createdAt: new Date().toISOString()
            };

            await persistRegisteredUser(newAccount);
            enterAuthenticatedSession(newAccount);
        } else {
            if (existingUser) {
                if (!(await verifyAndUpgradePassword(existingUser, password))) {
                    alert("❌ Contraseña incorrecta para este correo. Verifica e intenta nuevamente.");
                    return;
                }
                // Garantizar que cada dueño entre siempre a su propia base de datos aislada por correo
                if (existingUser.role === 'admin') {
                    const expectedKey = getOwnerWorkspaceKey(email);
                    if (existingUser.workspaceKey !== expectedKey) {
                        existingUser.workspaceKey = expectedKey;
                        if (email === PRIMARY_OWNER_EMAIL && !existingUser.companyName) {
                            existingUser.companyName = 'Lácteos Victoria';
                        }
                        await persistRegisteredUser(existingUser);
                    }
                }
                enterAuthenticatedSession(existingUser);
                return;
            }

            // Recuperación automática de tu cuenta base anterior (ballesterosjunior3@gmail.com)
            if (email === PRIMARY_OWNER_EMAIL) {
                const ownerAccount = {
                    email: PRIMARY_OWNER_EMAIL,
                    ...(await buildPasswordFields(password)),
                    role: 'admin',
                    companyName: 'Lácteos Victoria',
                    workspaceKey: DEFAULT_STORAGE_KEY,
                    createdAt: new Date().toISOString()
                };
                await persistRegisteredUser(ownerAccount);
                enterAuthenticatedSession(ownerAccount);
                return;
            }

            alert("⚠️ Este correo no está registrado. Toca la pestaña 'Registrarse' para crear tu cuenta nueva.");
        }
    } catch (err) {
        console.error("Error de autenticación:", err);
        alert("⚠️ No se pudo conectar con Firebase. Revisa tu conexión a internet e intenta de nuevo.");
    } finally {
        if (authBtn) {
            authBtn.disabled = false;
            authBtn.innerHTML = originalBtnHtml;
            if (window.lucide) lucide.createIcons();
        }
    }
}

function applyUserRoleInterface() {
    const navModules = document.getElementById('main-nav-modules');
    const headerRoleBadge = document.getElementById('header-role-badge');
    const configBtnTop = document.getElementById('config-btn-top');

    if (state.currentUserRole === 'conductor') {
        if (navModules) navModules.classList.add('hidden');
        if (headerRoleBadge) headerRoleBadge.innerText = `Conductor de Ruta (${state.currentUserEmail})`;
        if (configBtnTop) configBtnTop.classList.add('hidden');

        switchModule('leche');
        switchMilkTab('registro');
        const tabProv = document.getElementById('milk-tab-proveedores');
        const tabPagos = document.getElementById('milk-tab-pagos');
        if (tabProv) tabProv.classList.add('hidden');
        if (tabPagos) tabPagos.classList.add('hidden');
    } else {
        if (navModules) navModules.classList.remove('hidden');
        if (headerRoleBadge) headerRoleBadge.innerText = `Panel de Administración (${state.currentUserEmail || 'Dueño'})`;
        if (configBtnTop) configBtnTop.classList.remove('hidden');

        const tabProv = document.getElementById('milk-tab-proveedores');
        const tabPagos = document.getElementById('milk-tab-pagos');
        if (tabProv) tabProv.classList.remove('hidden');
        if (tabPagos) tabPagos.classList.remove('hidden');
        switchModule('cuentas');
    }
}

function logout() {
    clearSession();
    if (unsubscribeWorkspaceListener) {
        unsubscribeWorkspaceListener();
        unsubscribeWorkspaceListener = null;
    }
    currentWorkspaceKey = null;
    state = createEmptyAppState();

    const passwordInput = document.getElementById('password-input');
    if (passwordInput) passwordInput.value = '';

    const titleEl = document.getElementById('display-company-title');
    if (titleEl) titleEl.innerText = 'Lácteos Victoria';

    document.getElementById('main-app').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
}

function toggleNewClientForm() {
    document.getElementById('new-client-form').classList.toggle('hidden');
}

function saveClient() {
    const name = document.getElementById('new-client-name').value.trim();
    const phone = document.getElementById('new-client-phone').value.trim();
    if (!name) return;

    state.clients.push({ id: Date.now(), name, phone });
    saveData();
    renderClientSelect();
    renderPastDebtClientSelect();

    document.getElementById('client-select').value = state.clients[state.clients.length - 1].id;
    document.getElementById('new-client-name').value = '';
    document.getElementById('new-client-phone').value = '';
    toggleNewClientForm();
}

function rebuildSelect(select, html) {
    const previous = select.value;
    select.innerHTML = html;
    if (previous && Array.from(select.options).some(o => o.value === previous)) {
        select.value = previous;
    }
}

function clientOptionsHtml(placeholder) {
    return `<option value="">${placeholder}</option>` + state.clients.map(c =>
        `<option value="${esc(c.id)}">${esc(c.name)} ${c.phone ? '(' + esc(c.phone) + ')' : ''}</option>`).join('');
}

function renderClientSelect() {
    const select = document.getElementById('client-select');
    if (!select) return;
    rebuildSelect(select, clientOptionsHtml('-- Selecciona un comprador registrado --'));
}

function renderPastDebtClientSelect() {
    const select = document.getElementById('past-debt-client-select');
    if (!select) return;
    rebuildSelect(select, clientOptionsHtml('-- Selecciona cliente --'));
}

function addPastDebt(e) {
    e.preventDefault();
    const clientId = document.getElementById('past-debt-client-select').value;
    const dateVal = document.getElementById('past-debt-date').value;
    const concept = document.getElementById('past-debt-concept').value.trim();
    const amount = parseFloat(document.getElementById('past-debt-amount').value) || 0;

    if (!clientId || !dateVal || !concept || amount <= 0) {
        alert("⚠️ Por favor completa todos los campos correctamente.");
        return;
    }

    const client = state.clients.find(c => c.id == clientId);
    if (!client) return;

    state.clientDebts.push({
        id: Date.now(),
        clientId: client.id,
        clientName: client.name,
        date: dateVal,
        concept: `Saldo Anterior: ${concept}`,
        items: [],
        totalAmount: amount,
        paidAmount: 0,
        status: 'pendiente'
    });

    saveData();
    document.getElementById('past-debt-form').reset();
    const dateInput = document.getElementById('past-debt-date');
    if (dateInput) dateInput.value = getLocalDateString();

    renderClientAccountsTable();
    renderMonthlyBalance();
    alert("✅ Deuda histórica registrada con éxito.");
}

function toggleDebtDetails(debtId) {
    const detailRow = document.getElementById(`debt-detail-row-${debtId}`);
    const toggleBtn = document.getElementById(`debt-toggle-btn-${debtId}`);
    if (!detailRow) return;

    if (expandedDebtIds.has(debtId)) {
        expandedDebtIds.delete(debtId);
        detailRow.classList.add('hidden');
        if (toggleBtn) {
            toggleBtn.innerText = toggleBtn.dataset.closedLabel || 'Ver mercancía';
        }
    } else {
        expandedDebtIds.add(debtId);
        detailRow.classList.remove('hidden');
        if (toggleBtn) {
            toggleBtn.innerText = 'Ocultar';
        }
    }
}

// MÓDULO 1: CUENTAS POR COBRAR (RESUMEN + HISTORIAL DETALLADO DE FACTURAS)
function renderClientAccountsTable() {
    const summaryTbody = document.getElementById('client-summary-table-body');
    const detailedTbody = document.getElementById('client-detailed-invoices-table-body');
    if (!summaryTbody || !detailedTbody) return;

    summaryTbody.innerHTML = '';
    detailedTbody.innerHTML = '';

    let totalCarteraGeneral = 0;
    let debtorsSet = new Set();

    if (state.clientDebts.length === 0) {
        summaryTbody.innerHTML = '<tr><td colspan="5" class="text-center py-6 text-slate-400 font-medium">No hay cuentas por cobrar registradas. ¡Todos al día!</td></tr>';
        detailedTbody.innerHTML = '<tr><td colspan="8" class="text-center py-6 text-slate-400 font-medium">No hay facturas registradas.</td></tr>';
        document.getElementById('stat-total-deudas').innerText = '$0';
        document.getElementById('stat-clients-debtors').innerText = '0';
        return;
    }

    const clientSummaryMap = {};
    state.clientDebts.forEach(debt => {
        const saldo = Math.max(0, debt.totalAmount - debt.paidAmount);
        if (!clientSummaryMap[debt.clientId]) {
            clientSummaryMap[debt.clientId] = {
                clientName: debt.clientName,
                totalFiado: 0,
                totalAbonado: 0,
                saldoPendiente: 0,
                hasPending: false
            };
        }
        clientSummaryMap[debt.clientId].totalFiado += debt.totalAmount;
        clientSummaryMap[debt.clientId].totalAbonado += debt.paidAmount;
        clientSummaryMap[debt.clientId].saldoPendiente += saldo;
        if (saldo > 0) {
            clientSummaryMap[debt.clientId].hasPending = true;
            totalCarteraGeneral += saldo;
            debtorsSet.add(debt.clientId);
        }
    });

    Object.values(clientSummaryMap).forEach(summary => {
        const statusBadge = summary.saldoPendiente === 0
            ? '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">Al Día / Cancelado</span>'
            : '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800">Tiene Saldo Pendiente</span>';

        summaryTbody.innerHTML += `
            <tr class="border-b border-emerald-50 hover:bg-emerald-50/20">
                <td class="py-3 px-4 font-bold text-slate-900">${esc(summary.clientName)}</td>
                <td class="py-3 px-4 text-right font-mono font-bold text-slate-800">$${summary.totalFiado.toLocaleString('es-CO')}</td>
                <td class="py-3 px-4 text-right font-mono text-emerald-700">$${summary.totalAbonado.toLocaleString('es-CO')}</td>
                <td class="py-3 px-4 text-right font-mono font-black text-amber-800">$${summary.saldoPendiente.toLocaleString('es-CO')}</td>
                <td class="py-3 px-4 text-center">${statusBadge}</td>
            </tr>`;
    });

    const sortedDebts = [...state.clientDebts].sort((a, b) => b.id - a.id);

    sortedDebts.forEach(debt => {
        const saldoPendiente = Math.max(0, debt.totalAmount - debt.paidAmount);
        const statusBadge = debt.status === 'pagado'
            ? '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">Cancelado</span>'
            : '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800">Pendiente</span>';

        const itemsList = Array.isArray(debt.items) ? debt.items : [];
        const hasItems = itemsList.length > 0;
        const isExpanded = expandedDebtIds.has(debt.id);
        const closedLabel = hasItems ? `Ver mercancía (${itemsList.length})` : 'Ver detalle';
        const buttonLabel = isExpanded ? 'Ocultar' : closedLabel;

        let detailContentHtml = '';
        if (hasItems) {
            const totalOriginalVenta = debt.totalVentaOriginal || debt.totalAmount;
            const abonoInicial = debt.abonoInicial || 0;

            const itemRowsHtml = itemsList.map(item => {
                const cantidadTexto = item.saleType === 'kilos'
                    ? `${item.kilos} kg${item.blocksEquivalent ? ` (${item.blocksEquivalent} blq)` : ''}`
                    : `${item.units} und`;
                const precioUnitario = item.price || 0;
                const subtotalItem = item.saleType === 'kilos'
                    ? (precioUnitario * (item.kilos || 0))
                    : (precioUnitario * (item.units || 0));

                return `
                    <tr class="border-b border-slate-100">
                        <td class="py-1.5 px-3 font-bold text-slate-800">${esc(item.name)}</td>
                        <td class="py-1.5 px-3 font-mono text-slate-700">${cantidadTexto}</td>
                        <td class="py-1.5 px-3 text-right font-mono text-slate-600">$${precioUnitario.toLocaleString('es-CO')}</td>
                        <td class="py-1.5 px-3 text-right font-mono font-bold text-slate-900">$${subtotalItem.toLocaleString('es-CO')}</td>
                    </tr>`;
            }).join('');

            detailContentHtml = `
                <div class="bg-white rounded-xl p-3 border border-emerald-200 space-y-2">
                    <div class="flex flex-wrap justify-between items-center border-b border-slate-100 pb-2 gap-2">
                        <span class="text-xs font-bold text-emerald-900 uppercase">Mercancía vendida el ${esc(debt.date)} — ${esc(debt.clientName)}</span>
                        <span class="text-xs font-mono font-bold text-slate-700">Total Venta: $${totalOriginalVenta.toLocaleString('es-CO')}</span>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-left text-xs">
                            <thead>
                                <tr class="bg-emerald-50 text-emerald-900">
                                    <th class="py-1.5 px-3 font-bold">Producto</th>
                                    <th class="py-1.5 px-3 font-bold">Cantidad</th>
                                    <th class="py-1.5 px-3 font-bold text-right">Precio Unit.</th>
                                    <th class="py-1.5 px-3 font-bold text-right">Subtotal</th>
                                </tr>
                            </thead>
                            <tbody>${itemRowsHtml}</tbody>
                        </table>
                    </div>
                    <div class="flex flex-wrap justify-end gap-4 pt-1 text-xs font-mono">
                        ${abonoInicial > 0 ? `<span class="text-slate-600">Pagó al comprar: <strong>$${abonoInicial.toLocaleString('es-CO')}</strong></span>` : ''}
                        <span class="text-slate-700">Fiado inicial: <strong>$${debt.totalAmount.toLocaleString('es-CO')}</strong></span>
                        <span class="text-emerald-700">Abonado: <strong>$${debt.paidAmount.toLocaleString('es-CO')}</strong></span>
                        <span class="text-amber-800 font-bold">Debe: $${saldoPendiente.toLocaleString('es-CO')}</span>
                    </div>
                </div>`;
        } else {
            detailContentHtml = `
                <div class="bg-white rounded-xl p-3 border border-slate-200 flex flex-wrap justify-between items-center gap-2 text-xs">
                    <div>
                        <p class="font-bold text-slate-800">${esc(debt.concept)}</p>
                        <p class="text-slate-500 mt-0.5">Fecha: ${debt.date} • Registro sin desglose de productos del POS</p>
                    </div>
                    <div class="font-mono space-x-3">
                        <span class="text-slate-700">Valor: <strong>$${debt.totalAmount.toLocaleString('es-CO')}</strong></span>
                        <span class="text-emerald-700">Abonado: <strong>$${debt.paidAmount.toLocaleString('es-CO')}</strong></span>
                        <span class="text-amber-800 font-bold">Saldo: $${saldoPendiente.toLocaleString('es-CO')}</span>
                    </div>
                </div>`;
        }

        detailedTbody.innerHTML += `
            <tr class="border-b border-emerald-50 hover:bg-emerald-50/20">
                <td class="py-3 px-4 font-mono text-xs text-slate-500">${debt.date}</td>
                <td class="py-3 px-4 font-bold text-slate-900">${esc(debt.clientName)}</td>
                <td class="py-3 px-4 text-slate-700 text-xs">${esc(debt.concept)}</td>
                <td class="py-3 px-4 text-right font-mono font-bold text-slate-800">$${debt.totalAmount.toLocaleString('es-CO')}</td>
                <td class="py-3 px-4 text-right font-mono text-emerald-700">$${debt.paidAmount.toLocaleString('es-CO')}</td>
                <td class="py-3 px-4 text-right font-mono font-black text-amber-800">$${saldoPendiente.toLocaleString('es-CO')}</td>
                <td class="py-3 px-4 text-center">${statusBadge}</td>
                <td class="py-3 px-4 text-right space-x-1 whitespace-nowrap">
                    <button type="button" id="debt-toggle-btn-${debt.id}" data-closed-label="${closedLabel}" onclick="toggleDebtDetails(${debt.id})" class="text-xs bg-sky-100 hover:bg-slate-200 text-sky-800 font-bold px-2.5 py-1 rounded-lg">${buttonLabel}</button>
                    ${saldoPendiente > 0 ? `<button type="button" onclick="promptPaySpecificDebt(${debt.id})" class="text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-3 py-1 rounded-lg shadow-sm">Abonar Factura</button>` : ''}
                    <button type="button" onclick="deleteDebtRecord(${debt.id})" class="text-xs bg-red-100 hover:bg-red-200 text-red-700 font-bold px-2 py-1 rounded-lg">Eliminar</button>
                </td>
            </tr>
            <tr id="debt-detail-row-${debt.id}" class="${isExpanded ? '' : 'hidden'}">
                <td colspan="8" class="p-3 bg-slate-50 border-b border-slate-200">
                    ${detailContentHtml}
                </td>
            </tr>`;
    });

    document.getElementById('stat-total-deudas').innerText = `$${totalCarteraGeneral.toLocaleString('es-CO')}`;
    document.getElementById('stat-clients-debtors').innerText = debtorsSet.size;
}

function promptPaySpecificDebt(debtId) {
    const debt = state.clientDebts.find(d => d.id === debtId);
    if (!debt) return;
    const saldo = debt.totalAmount - debt.paidAmount;

    const inputAbono = prompt(`Abonar a factura de ${debt.clientName} (${debt.date} - ${debt.concept})\nSaldo pendiente de esta factura: $${saldo.toLocaleString('es-CO')}\n\nIngresa el valor del abono:`, saldo);
    if (inputAbono === null) return;
    const abono = parseFloat(inputAbono);
    if (isNaN(abono) || abono <= 0) {
        alert("⚠️ Ingresa un valor válido mayor a 0.");
        return;
    }
    if (abono > saldo) {
        alert(`⚠️ El abono no puede superar el saldo pendiente de esta factura ($${saldo.toLocaleString('es-CO')}).`);
        return;
    }

    const metP = prompt("Método de ingreso del abono (Efectivo / Nequi):", "Efectivo") || "Efectivo";

    debt.paidAmount = Math.min(debt.totalAmount, debt.paidAmount + abono);
    if (debt.paidAmount >= debt.totalAmount) {
        debt.status = 'pagado';
    }

    state.salesHistory.unshift({
        id: Date.now(),
        date: new Date().toLocaleString('es-CO'),
        rawDate: getLocalDateString(),
        clientName: debt.clientName,
        paymentMethod: metP,
        items: [{ name: `Abono a Factura (${debt.date} - ${debt.concept})`, saleType: 'unidad', units: 1, price: abono }],
        total: abono,
        isAbono: true
    });

    saveData();
    renderClientAccountsTable();
    renderSalesHistory();
    renderMonthlyBalance();
}

function deleteDebtRecord(id) {
    if (confirm("¿Estás seguro de eliminar este registro de cuenta por cobrar?")) {
        expandedDebtIds.delete(id);
        state.clientDebts = state.clientDebts.filter(d => d.id !== id);
        saveData();
        renderClientAccountsTable();
        renderMonthlyBalance();
    }
}

function addExpense(e) {
    e.preventDefault();
    const date = document.getElementById('exp-date-entry').value;
    const name = document.getElementById('exp-name-entry').value.trim();
    const amount = parseFloat(document.getElementById('exp-amount-entry').value) || 0;

    if (!date || !name || amount <= 0) {
        alert("⚠️ Completa fecha, concepto y un valor mayor a 0.");
        return;
    }

    state.expenses.unshift({ id: Date.now(), date, name, amount });
    saveData();

    document.getElementById('expense-form').reset();
    document.getElementById('exp-date-entry').value = getLocalDateString();
    renderExpensesTable();
    renderSalesHistory();
    renderMonthlyBalance();
}

function renderExpensesTable() {
    const tbody = document.getElementById('expenses-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (state.expenses.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center py-6 text-slate-400 font-medium">No hay gastos.</td></tr>';
        return;
    }

    state.expenses.forEach(exp => {
        tbody.innerHTML += `
            <tr class="border-b border-red-50 hover:bg-red-50/30">
                <td class="py-3 px-4 font-mono text-xs text-slate-500">${exp.date}</td>
                <td class="py-3 px-4 font-bold text-slate-800">${esc(exp.name)}</td>
                <td class="py-3 px-4 text-right font-mono font-black text-red-600">-$${exp.amount.toLocaleString('es-CO')}</td>
                <td class="py-3 px-4 text-right"><button onclick="deleteExpense(${exp.id})" class="text-xs bg-red-100 hover:bg-red-200 text-red-700 font-bold px-2 py-1 rounded-lg">Eliminar</button></td>
            </tr>`;
    });
}

function deleteExpense(id) {
    if (confirm("¿Eliminar gasto?")) {
        state.expenses = state.expenses.filter(exp => exp.id !== id);
        saveData();
        renderExpensesTable();
        renderSalesHistory();
        renderMonthlyBalance();
    }
}

function switchMilkTab(tabName) {
    const secReg = document.getElementById('milk-section-registro');
    const secProv = document.getElementById('milk-section-proveedores');
    const secPagos = document.getElementById('milk-section-pagos');
    const btnReg = document.getElementById('milk-tab-registro');
    const btnProv = document.getElementById('milk-tab-proveedores');
    const btnPagos = document.getElementById('milk-tab-pagos');

    if (tabName === 'registro') {
        if (secReg) secReg.classList.remove('hidden');
        if (secProv) secProv.classList.add('hidden');
        if (secPagos) secPagos.classList.add('hidden');
        if (btnReg) btnReg.className = "px-4 py-2 bg-sky-600 text-white font-bold text-sm rounded-xl shadow-sm transition-all whitespace-nowrap";
        if (btnProv) btnProv.className = "px-4 py-2 bg-slate-100 text-slate-700 font-bold text-sm rounded-xl hover:bg-slate-200 transition-all whitespace-nowrap";
        if (btnPagos) btnPagos.className = "px-4 py-2 bg-slate-100 text-slate-700 font-bold text-sm rounded-xl hover:bg-slate-200 transition-all whitespace-nowrap";
    } else if (tabName === 'proveedores') {
        if (state.currentUserRole === 'conductor') return;
        if (secReg) secReg.classList.add('hidden');
        if (secProv) secProv.classList.remove('hidden');
        if (secPagos) secPagos.classList.add('hidden');
        if (btnProv) btnProv.className = "px-4 py-2 bg-sky-600 text-white font-bold text-sm rounded-xl shadow-sm transition-all whitespace-nowrap";
        if (btnReg) btnReg.className = "px-4 py-2 bg-slate-100 text-slate-700 font-bold text-sm rounded-xl hover:bg-slate-200 transition-all whitespace-nowrap";
        if (btnPagos) btnPagos.className = "px-4 py-2 bg-slate-100 text-slate-700 font-bold text-sm rounded-xl hover:bg-slate-200 transition-all whitespace-nowrap";
    } else if (tabName === 'pagos') {
        if (state.currentUserRole === 'conductor') return;
        if (secReg) secReg.classList.add('hidden');
        if (secProv) secProv.classList.add('hidden');
        if (secPagos) secPagos.classList.remove('hidden');
        if (btnPagos) btnPagos.className = "px-4 py-2 bg-sky-600 text-white font-bold text-sm rounded-xl shadow-sm transition-all whitespace-nowrap";
        if (btnReg) btnReg.className = "px-4 py-2 bg-slate-100 text-slate-700 font-bold text-sm rounded-xl hover:bg-slate-200 transition-all whitespace-nowrap";
        if (btnProv) btnProv.className = "px-4 py-2 bg-slate-100 text-slate-700 font-bold text-sm rounded-xl hover:bg-slate-200 transition-all whitespace-nowrap";
        renderMilkPaymentsTable();
    }
}

function addMilkProvider(e) {
    e.preventDefault();
    if (state.currentUserRole === 'conductor') return;
    const name = document.getElementById('prov-name').value.trim();
    const pricePerLiter = parseFloat(document.getElementById('prov-price').value) || 0;

    if (!name || pricePerLiter <= 0) return;

    state.milkProviders.push({ id: Date.now(), name, pricePerLiter });
    saveData();
    document.getElementById('provider-form').reset();
    renderMilkProvidersSelect();
    renderProvidersTable();
}

function renderMilkProvidersSelect() {
    const select = document.getElementById('daily-milk-provider-select');
    if (!select) return;
    rebuildSelect(select, '<option value="">-- Elige un proveedor --</option>' +
        state.milkProviders.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''));
}

function renderProvidersTable() {
    const tbody = document.getElementById('providers-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (state.milkProviders.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center py-6 text-slate-400 font-medium">No hay proveedores.</td></tr>';
        const statProv = document.getElementById('stat-milk-providers');
        if (statProv) statProv.innerText = '0';
        return;
    }

    const statProv = document.getElementById('stat-milk-providers');
    if (statProv) statProv.innerText = state.milkProviders.length;

    state.milkProviders.forEach(prov => {
        let totalLiters = 0;
        state.dailyMilkLogs.forEach(log => {
            if (log.providerId === prov.id && !log.paid) totalLiters += log.liters;
        });

        const totalToPay = totalLiters * prov.pricePerLiter;
        tbody.innerHTML += `
            <tr class="border-b border-sky-50 hover:bg-sky-50/40">
                <td class="py-3 px-4 font-bold text-slate-800">${esc(prov.name)}</td>
                <td class="py-3 px-4 font-mono text-slate-600">$${prov.pricePerLiter.toLocaleString('es-CO')}</td>
                <td class="py-3 px-4 font-mono text-sky-800 font-bold">${totalLiters} Litros</td>
                <td class="py-3 px-4 text-right font-mono font-black text-emerald-700">$${totalToPay.toLocaleString('es-CO')}</td>
                <td class="py-3 px-4 text-right space-x-1">
                    <button onclick="payProviderQuincena(${prov.id})" class="text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-3 py-1.5 rounded-lg shadow-sm">Pagar</button>
                    <button onclick="editProviderPrice(${prov.id})" class="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-2 py-1.5 rounded-lg">Precio</button>
                    <button onclick="deleteProvider(${prov.id})" class="text-xs bg-red-100 hover:bg-red-200 text-red-700 font-bold px-2 py-1.5 rounded-lg">X</button>
                </td>
            </tr>`;
    });
}

function payProviderQuincena(providerId) {
    const prov = state.milkProviders.find(p => p.id === providerId);
    if (!prov) return;

    let totalLiters = 0;
    state.dailyMilkLogs.forEach(log => {
        if (log.providerId === prov.id && !log.paid) totalLiters += log.liters;
    });

    const totalToPay = totalLiters * prov.pricePerLiter;
    if (totalToPay <= 0) return;

    if (!confirm(`¿Pagar quincena a ${prov.name} por $${totalToPay.toLocaleString('es-CO')} (${totalLiters} L)?`)) return;

    const paymentDate = getLocalDateString();

    state.milkPayments.unshift({
        id: Date.now(),
        date: paymentDate,
        providerName: prov.name,
        liters: totalLiters,
        pricePerLiter: prov.pricePerLiter,
        totalPaid: totalToPay
    });

    state.expenses.unshift({
        id: Date.now() + 1,
        date: paymentDate,
        name: `Pago Quincena Leche: ${prov.name} (${totalLiters} L)`,
        amount: totalToPay
    });

    // Los registros se marcan como liquidados (no se borran) para conservar el historial y el costo del Módulo 5.
    state.dailyMilkLogs = state.dailyMilkLogs.map(log =>
        (log.providerId === prov.id && !log.paid) ? { ...log, paid: true, paidDate: paymentDate } : log);

    saveData();
    renderProvidersTable();
    renderMilkPaymentsTable();
    renderDailyMilkTable();
    renderExpensesTable();
    renderSalesHistory();
    renderMonthlyBalance();
}

function renderMilkPaymentsTable() {
    const tbody = document.getElementById('milk-payments-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (state.milkPayments.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center py-6 text-slate-400 font-medium">No hay pagos de leche registrados todavía.</td></tr>';
        return;
    }

    state.milkPayments.forEach(payment => {
        tbody.innerHTML += `
            <tr class="border-b border-sky-50 hover:bg-sky-50/30">
                <td class="py-3 px-4 font-mono text-xs text-slate-500">${payment.date}</td>
                <td class="py-3 px-4 font-bold text-slate-800">${esc(payment.providerName)}</td>
                <td class="py-3 px-4 font-mono text-sky-800 font-bold">${payment.liters} Litros</td>
                <td class="py-3 px-4 font-mono text-slate-600">$${(payment.pricePerLiter || 0).toLocaleString('es-CO')}</td>
                <td class="py-3 px-4 text-right font-mono font-black text-emerald-700">$${payment.totalPaid.toLocaleString('es-CO')}</td>
                <td class="py-3 px-4 text-right"><button onclick="deleteMilkPayment(${payment.id})" class="text-xs bg-red-100 hover:bg-red-200 text-red-700 font-bold px-2 py-1 rounded-lg">Eliminar</button></td>
            </tr>`;
    });
}

function deleteMilkPayment(id) {
    if (confirm("¿Eliminar este registro de pago de leche?")) {
        state.milkPayments = state.milkPayments.filter(p => p.id !== id);
        saveData();
        renderMilkPaymentsTable();
        renderMonthlyBalance();
    }
}

function editProviderPrice(id) {
    const prov = state.milkProviders.find(p => p.id === id);
    if (!prov) return;
    const np = prompt(`Nuevo precio por litro para ${prov.name}:`, prov.pricePerLiter);
    if (np !== null && !isNaN(np)) {
        prov.pricePerLiter = parseFloat(np);
        saveData();
        renderMilkProvidersSelect();
        renderProvidersTable();
        renderDailyMilkTable();
    }
}

function deleteProvider(id) {
    const pendingLiters = state.dailyMilkLogs
        .filter(l => l.providerId === id && !l.paid)
        .reduce((acc, l) => acc + (Number(l.liters) || 0), 0);
    if (pendingLiters > 0) {
        alert(`⚠️ Este proveedor tiene ${pendingLiters} litros sin pagar. Primero usa "Pagar" (o cierra la quincena) y luego lo puedes eliminar.`);
        return;
    }
    if (confirm("¿Eliminar proveedor? Su historial de litros se conserva para los costos.")) {
        state.milkProviders = state.milkProviders.filter(p => p.id !== id);
        saveData();
        renderMilkProvidersSelect();
        renderProvidersTable();
        renderDailyMilkTable();
    }
}

function addDailyMilk(e) {
    e.preventDefault();
    const dateInput = document.getElementById('daily-milk-date');
    const providerSelect = document.getElementById('daily-milk-provider-select');
    const litersInput = document.getElementById('daily-milk-liters');

    if (!dateInput || !providerSelect || !litersInput) return;

    const date = dateInput.value;
    const providerId = parseInt(providerSelect.value);
    const liters = parseFloat(litersInput.value) || 0;

    if (!date || !providerId || liters <= 0) return;

    const provider = state.milkProviders.find(p => p.id === providerId);
    if (!provider) return;

    state.dailyMilkLogs.unshift({
        id: Date.now(),
        date,
        providerId,
        providerName: provider.name,
        liters,
        pricePerLiter: provider.pricePerLiter,
        registeredBy: state.currentUserEmail || 'Conductor'
    });

    saveData();
    litersInput.value = '';
    renderDailyMilkTable();
    renderProvidersTable();
}

function renderDailyMilkTable() {
    const tbody = document.getElementById('daily-milk-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    const todayStr = getLocalDateString();
    let totalLitersToday = 0, totalCostToday = 0;

    if (state.dailyMilkLogs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center py-6 text-slate-400 font-medium">No hay entregas registradas.</td></tr>';
    } else {
        state.dailyMilkLogs.forEach(log => {
            if (log.date === todayStr) {
                totalLitersToday += log.liters;
                totalCostToday += (log.liters * log.pricePerLiter);
            }
            tbody.innerHTML += `
                <tr class="border-b border-sky-50">
                    <td class="py-3 px-4 font-mono text-xs text-slate-500">${log.date}</td>
                    <td class="py-3 px-4 font-bold text-slate-800">${esc(log.providerName)} <span class="text-[10px] text-slate-400">(${esc(log.registeredBy)})</span></td>
                    <td class="py-3 px-4 font-mono text-sky-800 font-bold">${log.liters} Litros${log.paid ? ' <span class="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-sans">Liquidado</span>' : ''}</td>
                    <td class="py-3 px-4 text-right"><button onclick="deleteDailyMilk(${log.id})" class="text-xs bg-red-100 hover:bg-red-200 text-red-700 font-bold px-2 py-1 rounded-lg">Eliminar</button></td>
                </tr>`;
        });
    }

    const statMilkToday = document.getElementById('stat-milk-today');
    const statMilkCost = document.getElementById('stat-milk-cost');
    if (statMilkToday) statMilkToday.innerText = `${totalLitersToday} L`;
    if (statMilkCost) statMilkCost.innerText = `$${totalCostToday.toLocaleString('es-CO')}`;
}

function deleteDailyMilk(id) {
    if (confirm("¿Eliminar registro?")) {
        state.dailyMilkLogs = state.dailyMilkLogs.filter(l => l.id !== id);
        saveData();
        renderDailyMilkTable();
        renderProvidersTable();
    }
}

function resetQuincena() {
    if (state.currentUserRole === 'conductor') return;
    if (confirm("¿Cerrar la quincena? Los litros pendientes dejan de sumar al acumulado (quedan en el historial). Esto NO registra ningún pago: usa 'Pagar' en cada proveedor para pagar.")) {
        const closeDate = getLocalDateString();
        state.dailyMilkLogs = state.dailyMilkLogs.map(log => log.paid ? log : { ...log, paid: true, paidDate: closeDate });
        saveData();
        renderDailyMilkTable();
        renderProvidersTable();
    }
}

function parseNumericInput(rawVal) {
    if (rawVal === null || rawVal === undefined) return 0;
    if (typeof rawVal === 'number') return isNaN(rawVal) ? 0 : rawVal;
    let str = String(rawVal).trim().replace(/\$/g, '').replace(/\s+/g, '');
    if (!str) return 0;
    // Si tiene punto de miles colombiano (ej: 18.000 o 1.250.000), quitar los puntos de miles
    if (/^-?\d{1,3}(\.\d{3})+$/.test(str)) {
        str = str.replace(/\./g, '');
    } else if (str.includes(',') && !str.includes('.')) {
        // Decimal con coma (ej: 8,25 -> 8.25)
        str = str.replace(',', '.');
    } else if (str.includes('.') && str.includes(',')) {
        // Formato 18.000,50 -> 18000.50
        str = str.replace(/\./g, '').replace(',', '.');
    }
    const num = parseFloat(str);
    return isNaN(num) ? 0 : num;
}

function getYieldUnitSuffix(type) {
    if (type === 'libras') return 'lb';
    if (type === 'unidades') return 'und';
    return 'kg';
}

function getEffectiveMilkPricePerLiter(milkLog) {
    if (!milkLog) return 0;
    if (milkLog.pricePerLiter && Number(milkLog.pricePerLiter) > 0) {
        return Number(milkLog.pricePerLiter);
    }
    const prov = state.milkProviders.find(p => p.id === milkLog.providerId || p.name === milkLog.providerName);
    return prov && prov.pricePerLiter ? Number(prov.pricePerLiter) : 0;
}

function getGlobalProvidersAvgPrice() {
    const valid = state.milkProviders.filter(p => Number(p.pricePerLiter) > 0);
    if (valid.length === 0) return 0;
    const sum = valid.reduce((acc, p) => acc + Number(p.pricePerLiter), 0);
    return sum / valid.length;
}

function handleYieldTypeChange(preserveCustomTarget = false) {
    const typeEl = document.getElementById('yield-type');
    const type = typeEl ? typeEl.value : 'kilos';
    const weightLabel = document.getElementById('yield-weight-label');
    const priceLabel = document.getElementById('yield-price-label');
    const targetLabel = document.getElementById('yield-target-label');
    const targetInput = document.getElementById('yield-custom-target');
    const weightInput = document.getElementById('yield-weight-val');
    const priceInput = document.getElementById('yield-sale-price');

    if (type === 'kilos') {
        if (weightLabel) weightLabel.innerText = 'Peso Total Obtenido (Kilos)';
        if (priceLabel) priceLabel.innerText = 'Precio de Venta por Kilo ($)';
        if (targetLabel) targetLabel.innerText = 'Tu Meta / Promedio (kg/cant)';
        if (targetInput && !preserveCustomTarget) targetInput.value = '8.25';
        if (weightInput) weightInput.placeholder = 'Ej: 85.5';
        if (priceInput) priceInput.placeholder = 'Ej: 18000';
    } else if (type === 'libras') {
        if (weightLabel) weightLabel.innerText = 'Peso Total Obtenido (Libras)';
        if (priceLabel) priceLabel.innerText = 'Precio de Venta por Libra ($)';
        if (targetLabel) targetLabel.innerText = 'Tu Meta / Promedio (lb/cant)';
        if (targetInput && !preserveCustomTarget) targetInput.value = '16.5';
        if (weightInput) weightInput.placeholder = 'Ej: 170';
        if (priceInput) priceInput.placeholder = 'Ej: 9500';
    } else {
        if (weightLabel) weightLabel.innerText = 'Cantidad Total Obtenida (Unidades)';
        if (priceLabel) priceLabel.innerText = 'Precio de Venta por Unidad ($)';
        if (targetLabel) targetLabel.innerText = 'Tu Meta / Promedio (und/cant)';
        if (targetInput && !preserveCustomTarget) targetInput.value = '12';
        if (weightInput) weightInput.placeholder = 'Ej: 48';
        if (priceInput) priceInput.placeholder = 'Ej: 8000';
    }

    if (preserveCustomTarget && targetInput) {
        if (type === 'libras' && (!targetInput.value || Number(targetInput.value) === 8.25)) {
            targetInput.value = '16.5';
        } else if (type === 'kilos' && (!targetInput.value || Number(targetInput.value) === 16.5)) {
            targetInput.value = '8.25';
        } else if (type === 'unidades' && (!targetInput.value || Number(targetInput.value) === 8.25 || Number(targetInput.value) === 16.5)) {
            targetInput.value = '12';
        }
    }

    const nameInput = document.getElementById('yield-product-name');
    updateYieldTopCardForSelectedProduct(nameInput ? nameInput.value : '');
    updateYieldLivePreview();
}

function onYieldProductSelectChange() {
    const select = document.getElementById('yield-product-select');
    const nameInput = document.getElementById('yield-product-name');
    const typeSelect = document.getElementById('yield-type');
    const targetInput = document.getElementById('yield-custom-target');

    if (!select || !nameInput) return;

    const val = select.value;
    if (val === 'Personalizado') {
        nameInput.value = '';
        nameInput.focus();
        updateYieldTopCardForSelectedProduct('');
        updateYieldLivePreview();
        return;
    }

    nameInput.value = val;

    // Buscar si ya existe historial de este producto para respetar la última meta y presentación usadas
    const searchKey = val.toLowerCase().trim();
    const lastLogForProduct = state.yieldLogs.find(l => (l.productName || '').toLowerCase().trim() === searchKey);

    if (lastLogForProduct) {
        if (typeSelect) typeSelect.value = lastLogForProduct.yieldType || 'kilos';
        if (targetInput && lastLogForProduct.customTarget !== undefined) {
            targetInput.value = lastLogForProduct.customTarget;
        }
        handleYieldTypeChange(true);
    } else {
        if (val.toLowerCase().includes('libra')) {
            if (typeSelect) typeSelect.value = 'libras';
            if (targetInput) targetInput.value = '16.5';
        } else if (val.toLowerCase().includes('unidad')) {
            if (typeSelect) typeSelect.value = 'unidades';
            if (targetInput) targetInput.value = '12';
        } else if (val.toLowerCase().includes('criollo')) {
            if (typeSelect) typeSelect.value = 'kilos';
            if (targetInput) targetInput.value = '8.0';
        } else if (val.toLowerCase().includes('pasteurizado')) {
            if (typeSelect) typeSelect.value = 'kilos';
            if (targetInput) targetInput.value = '8.25';
        } else if (val.toLowerCase().includes('cuajada')) {
            if (typeSelect) typeSelect.value = 'kilos';
            if (targetInput) targetInput.value = '9.0';
        } else {
            if (typeSelect) typeSelect.value = 'kilos';
            if (targetInput) targetInput.value = '8.25';
        }
        handleYieldTypeChange(true);
    }

    updateYieldTopCardForSelectedProduct(nameInput.value);
    updateYieldLivePreview();
}

function onYieldProductNameInput() {
    const nameInput = document.getElementById('yield-product-name');
    updateYieldTopCardForSelectedProduct(nameInput ? nameInput.value : '');
    updateYieldLivePreview();
}

function onYieldTargetInput() {
    const nameInput = document.getElementById('yield-product-name');
    updateYieldTopCardForSelectedProduct(nameInput ? nameInput.value : '');
    updateYieldLivePreview();
}

function updateYieldTopCardForSelectedProduct(productName) {
    const statPromedioEl = document.getElementById('stat-yield-promedio');
    if (!statPromedioEl) return;

    const currentTypeEl = document.getElementById('yield-type');
    const currentType = currentTypeEl ? currentTypeEl.value : 'kilos';
    const currentUnit = `${getYieldUnitSuffix(currentType)}/cant`;
    const targetInput = document.getElementById('yield-custom-target');
    const targetVal = targetInput ? parseNumericInput(targetInput.value) : 0;

    if (!productName || productName.trim() === '') {
        statPromedioEl.innerText = `${targetVal || 0} ${currentUnit} (Meta)`;
        return;
    }

    const searchKey = productName.toLowerCase().trim();
    const logsOfProduct = state.yieldLogs.filter(l => {
        const pName = (l.productName || '').toLowerCase().trim();
        const sameUnit = (l.yieldType || 'kilos') === currentType;
        return sameUnit && (pName === searchKey || pName.includes(searchKey) || searchKey.includes(pName));
    });

    if (logsOfProduct.length === 0) {
        statPromedioEl.innerText = `${targetVal || 0} ${currentUnit} (Meta)`;
    } else {
        // Promedio ponderado real: Peso Total Acumulado / Cantinas Totales Acumuladas
        let totalWeightSum = 0;
        let totalCantinasSum = 0;
        logsOfProduct.forEach(l => {
            const liters = Number(l.liters) || 0;
            const cant = liters > 0 ? (liters / 40) : (Number(l.cantinasExactas) || 0);
            totalWeightSum += (Number(l.totalWeight) || 0);
            totalCantinasSum += cant;
        });
        const promedioReal = totalCantinasSum > 0 ? (totalWeightSum / totalCantinasSum).toFixed(2) : '0.00';
        statPromedioEl.innerText = `${promedioReal} ${currentUnit} (Meta: ${targetVal || 0})`;
    }
}

function updateYieldLivePreview() {
    const liters = parseNumericInput(document.getElementById('yield-liters')?.value);
    const milkCost = parseNumericInput(document.getElementById('yield-milk-cost')?.value);
    const yieldType = document.getElementById('yield-type')?.value || 'kilos';
    const customTarget = parseNumericInput(document.getElementById('yield-custom-target')?.value);
    const totalWeight = parseNumericInput(document.getElementById('yield-weight-val')?.value);
    const salePricePerUnit = parseNumericInput(document.getElementById('yield-sale-price')?.value);

    const unitSuffix = getYieldUnitSuffix(yieldType);
    const exactCantinas = liters > 0 ? (liters / 40) : 0;
    const promedioActual = exactCantinas > 0 && totalWeight > 0 ? (totalWeight / exactCantinas) : 0;
    const costoPorUnidad = totalWeight > 0 && milkCost > 0 ? (milkCost / totalWeight) : 0;
    const totalVentaLote = totalWeight * salePricePerUnit;
    const gananciaNetaLote = totalVentaLote - milkCost;

    const cantinasBadge = document.getElementById('live-cantinas-badge');
    const promedioEl = document.getElementById('live-promedio-val');
    const metaStatusEl = document.getElementById('live-meta-status');
    const unitCostEl = document.getElementById('live-unit-cost');
    const totalSaleEl = document.getElementById('live-total-sale');
    const netProfitEl = document.getElementById('live-net-profit');

    if (cantinasBadge) {
        cantinasBadge.innerText = `${exactCantinas.toFixed(2)} cantinas (${liters} L)`;
    }

    if (promedioEl) {
        promedioEl.innerText = `${promedioActual.toFixed(2)} ${unitSuffix}/cant`;
        if (totalWeight <= 0 || liters <= 0) {
            promedioEl.className = 'font-mono font-black text-sm text-slate-300';
        } else if (customTarget > 0 && promedioActual >= customTarget) {
            promedioEl.className = 'font-mono font-black text-sm text-emerald-400';
        } else {
            promedioEl.className = 'font-mono font-black text-sm text-red-400';
        }
    }

    if (metaStatusEl) {
        if (liters <= 0 || totalWeight <= 0) {
            metaStatusEl.innerText = `Meta: ${customTarget} ${unitSuffix}/cant`;
            metaStatusEl.className = 'font-bold text-slate-300';
        } else if (customTarget > 0) {
            const diff = promedioActual - customTarget;
            if (diff >= 0) {
                metaStatusEl.innerText = `✅ Cumple (+${diff.toFixed(2)} ${unitSuffix}/cant sobre meta ${customTarget})`;
                metaStatusEl.className = 'font-bold text-emerald-400';
            } else {
                metaStatusEl.innerText = `⚠️ Bajo meta (${diff.toFixed(2)} ${unitSuffix}/cant vs meta ${customTarget})`;
                metaStatusEl.className = 'font-bold text-amber-400';
            }
        } else {
            metaStatusEl.innerText = 'Sin meta definida';
            metaStatusEl.className = 'font-bold text-slate-400';
        }
    }

    if (unitCostEl) {
        unitCostEl.innerText = `$${Math.round(costoPorUnidad).toLocaleString('es-CO')} / ${unitSuffix}`;
    }

    if (totalSaleEl) {
        totalSaleEl.innerText = `$${Math.round(totalVentaLote).toLocaleString('es-CO')}`;
    }

    if (netProfitEl) {
        const roundedProfit = Math.round(gananciaNetaLote);
        const sign = roundedProfit > 0 ? '+' : '';
        netProfitEl.innerText = `${sign}$${roundedProfit.toLocaleString('es-CO')}`;
        if (totalWeight <= 0 || salePricePerUnit <= 0) {
            netProfitEl.className = 'font-black text-slate-300';
        } else if (roundedProfit >= 0) {
            netProfitEl.className = 'font-black text-emerald-400';
        } else {
            netProfitEl.className = 'font-black text-red-400';
        }
    }
}

function onYieldDateChange() {
    const dateVal = document.getElementById('yield-date').value;
    const litersInput = document.getElementById('yield-liters');
    const costInput = document.getElementById('yield-milk-cost');
    const detailsEl = document.getElementById('milk-pull-details');
    const submitBtn = document.getElementById('yield-submit-btn');

    if (!dateVal) {
        litersInput.value = '';
        costInput.value = '';
        detailsEl.innerText = 'Selecciona una fecha de producción...';
        currentDayMilkData = { totalLiters: 0, totalCost: 0, avgCostPerLiter: 0, remainingLiters: 0, hasDayLogs: false };
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.className = "w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 rounded-xl text-sm transition-all shadow-md";
        }
        updateYieldLivePreview();
        return;
    }

    const logsForDate = state.dailyMilkLogs.filter(l => l.date === dateVal);

    if (logsForDate.length === 0) {
        const fallbackAvgPrice = getGlobalProvidersAvgPrice();
        currentDayMilkData = {
            totalLiters: 0,
            totalCost: 0,
            avgCostPerLiter: fallbackAvgPrice,
            remainingLiters: Infinity,
            hasDayLogs: false
        };
        if (fallbackAvgPrice > 0) {
            detailsEl.innerHTML = `<span class="text-amber-800 font-bold">ℹ️ Sin acopio cargado en Módulo 4 el ${dateVal}. Usando tarifa promedio de proveedores ($${Math.round(fallbackAvgPrice).toLocaleString('es-CO')}/L).</span>`;
        } else {
            detailsEl.innerHTML = `<span class="text-amber-800 font-bold">ℹ️ Sin acopio en Módulo 4 el ${dateVal}. Puedes ingresar litros y costo de leche manualmente.</span>`;
        }
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.className = "w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 rounded-xl text-sm transition-all shadow-md";
        }
        onYieldLitersInput();
        return;
    }

    let totalLitersDay = 0;
    let totalCostDay = 0;
    logsForDate.forEach(l => {
        const liters = Number(l.liters) || 0;
        const unitPrice = getEffectiveMilkPricePerLiter(l);
        totalLitersDay += liters;
        totalCostDay += (liters * unitPrice);
    });

    const avgCostPerLiter = totalLitersDay > 0 ? totalCostDay / totalLitersDay : getGlobalProvidersAvgPrice();

    let usedLitersDay = 0;
    state.yieldLogs.forEach(y => {
        if (y.date === dateVal) {
            usedLitersDay += (Number(y.liters) || 0);
        }
    });

    const remainingLiters = Math.max(0, totalLitersDay - usedLitersDay);
    currentDayMilkData = {
        totalLiters: totalLitersDay,
        totalCost: totalCostDay,
        avgCostPerLiter,
        remainingLiters,
        hasDayLogs: true
    };

    if (remainingLiters <= 0) {
        litersInput.value = 0;
        costInput.value = 0;
        detailsEl.innerHTML = `<span class="text-red-600 font-bold">🔒 La leche del ${dateVal} ya fue utilizada al 100% (${totalLitersDay} L).</span>`;
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.className = "w-full bg-slate-300 text-slate-500 font-bold py-3 rounded-xl text-sm cursor-not-allowed";
        }
        updateYieldLivePreview();
        return;
    } else {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.className = "w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 rounded-xl text-sm transition-all shadow-md";
        }
    }

    litersInput.value = remainingLiters;
    onYieldLitersInput();

    const cantinasTotal = (totalLitersDay / 40).toFixed(2);
    const cantinasRem = (remainingLiters / 40).toFixed(2);

    detailsEl.innerHTML = `
        <p class="font-bold text-emerald-950">🥛 Día ${dateVal} — Total: <b>${totalLitersDay} L</b> (${cantinasTotal} cant) | Usado: <b>${usedLitersDay} L</b></p>
        <p class="font-bold text-amber-800 mt-0.5">✨ Disponible: <b>${remainingLiters} L</b> (~${cantinasRem} cantinas) @ $${Math.round(avgCostPerLiter).toLocaleString('es-CO')}/L</p>
    `;
}

function onYieldLitersInput() {
    const allocatedLiters = parseNumericInput(document.getElementById('yield-liters')?.value);
    const costInput = document.getElementById('yield-milk-cost');

    if (costInput && currentDayMilkData.avgCostPerLiter > 0) {
        const proportionalCost = Math.round(allocatedLiters * currentDayMilkData.avgCostPerLiter);
        costInput.value = proportionalCost;
    } else if (costInput && allocatedLiters <= 0) {
        costInput.value = 0;
    }

    updateYieldLivePreview();
}

function addYieldLog(e) {
    e.preventDefault();
    const date = document.getElementById('yield-date').value;
    const productSelect = document.getElementById('yield-product-select');
    const selectedOption = productSelect ? productSelect.value : 'Bloque Pasteurizado';
    const productNameInput = document.getElementById('yield-product-name');
    const productName = productNameInput ? productNameInput.value.trim() : 'Queso';
    const liters = parseNumericInput(document.getElementById('yield-liters').value);
    const milkCost = parseNumericInput(document.getElementById('yield-milk-cost').value);
    const yieldType = document.getElementById('yield-type').value;
    const defaultTarget = yieldType === 'libras' ? 16.5 : (yieldType === 'unidades' ? 12 : 8.25);
    const customTarget = parseNumericInput(document.getElementById('yield-custom-target').value) || defaultTarget;
    const totalWeight = parseNumericInput(document.getElementById('yield-weight-val').value);
    const salePricePerUnit = parseNumericInput(document.getElementById('yield-sale-price').value);

    if (!date || !productName) {
        alert("⚠️ Selecciona la fecha y escribe el nombre del producto.");
        return;
    }
    if (liters <= 0) {
        alert("⚠️ Ingresa una cantidad válida de litros utilizados.");
        return;
    }
    if (milkCost <= 0) {
        alert("⚠️ El costo de la leche debe ser mayor a $0.");
        return;
    }
    if (totalWeight <= 0) {
        alert("⚠️ Ingresa el peso o cantidad total obtenida del lote.");
        return;
    }
    if (salePricePerUnit <= 0) {
        alert("⚠️ Ingresa el precio de venta por unidad/kilo/libra.");
        return;
    }

    if (currentDayMilkData.hasDayLogs) {
        let totalLitersDay = 0;
        state.dailyMilkLogs.forEach(l => { if (l.date === date) totalLitersDay += (Number(l.liters) || 0); });
        let usedLitersDay = 0;
        state.yieldLogs.forEach(y => { if (y.date === date) usedLitersDay += (Number(y.liters) || 0); });
        const remainingLiters = totalLitersDay - usedLitersDay;

        if (liters > remainingLiters + 0.001) {
            alert(`⚠️ Solo quedan ${remainingLiters} litros disponibles para el día ${date}.`);
            return;
        }
    }

    // Cálculo exacto sobre cantinas de 40 L (sin redondear prematuramente antes de dividir)
    const exactCantinas = liters / 40;
    const cantinasExactas = parseFloat(exactCantinas.toFixed(2));
    const cantinasEnteras = Math.floor(liters / 40);
    const litrosSobrantes = parseFloat((liters % 40).toFixed(2));
    const promedioPorCantina = exactCantinas > 0 ? parseFloat((totalWeight / exactCantinas).toFixed(2)) : 0;
    const costoPorUnidad = totalWeight > 0 ? Math.round(milkCost / totalWeight) : 0;
    const totalVentaLote = Math.round(totalWeight * salePricePerUnit);
    const gananciaNetaLote = Math.round(totalVentaLote - milkCost);

    state.yieldLogs.unshift({
        id: Date.now(),
        date,
        productName,
        liters,
        cantinasText: `${cantinasEnteras} cant${litrosSobrantes > 0 ? ' + ' + litrosSobrantes + 'L' : ''} (${cantinasExactas} cant)`,
        cantinasExactas,
        milkCost: Math.round(milkCost),
        yieldType,
        customTarget,
        totalWeight,
        promedioPorCantina,
        costoPorUnidad,
        salePricePerUnit,
        totalVentaLote,
        gananciaNetaLote
    });

    saveData();

    // Limpiar solo peso y precio de venta, manteniendo la fecha, el producto y tu meta configurada
    const weightInput = document.getElementById('yield-weight-val');
    const priceInput = document.getElementById('yield-sale-price');
    if (weightInput) weightInput.value = '';
    if (priceInput) priceInput.value = '';
    if (productSelect) productSelect.value = selectedOption;
    if (productNameInput) productNameInput.value = productName;

    onYieldDateChange();
    updateYieldTopCardForSelectedProduct(productName);
    updateYieldLivePreview();
    renderYieldTable();
}

function renderYieldTable() {
    const tbody = document.getElementById('yield-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    let totalCantinasGeneral = 0;
    let sumaGanancias = 0;
    let count = state.yieldLogs.length;

    if (count === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-slate-400 font-medium">No hay registros de rendimiento.</td></tr>';
        document.getElementById('stat-yield-cantinas').innerText = '0 Cantinas';
        document.getElementById('stat-yield-profit').innerText = '$0';
        const productNameInput = document.getElementById('yield-product-name');
        updateYieldTopCardForSelectedProduct(productNameInput ? productNameInput.value : '');
        return;
    }

    state.yieldLogs.forEach(log => {
        const liters = Number(log.liters) || 0;
        const exactCantinas = liters > 0 ? (liters / 40) : (Number(log.cantinasExactas) || 0);
        const cantinasExactas = parseFloat(exactCantinas.toFixed(2));
        const cantinasText = log.cantinasText || `${cantinasExactas.toFixed(2)} cant`;
        const productName = log.productName || 'Queso / Lote';
        const yieldType = log.yieldType || 'kilos';
        const totalWeight = Number(log.totalWeight) || 0;
        const defaultTarget = yieldType === 'libras' ? 16.5 : (yieldType === 'unidades' ? 12 : 8.25);
        const customTarget = log.customTarget !== undefined ? Number(log.customTarget) : defaultTarget;
        const promedioPorCantina = exactCantinas > 0
            ? parseFloat((totalWeight / exactCantinas).toFixed(2))
            : (Number(log.promedioPorCantina) || 0);
        const milkCost = Number(log.milkCost) || 0;
        const costoPorUnidad = totalWeight > 0 ? Math.round(milkCost / totalWeight) : (Number(log.costoPorUnidad) || 0);
        const salePricePerUnit = Number(log.salePricePerUnit) || 0;
        const totalVentaLote = log.totalVentaLote !== undefined ? Number(log.totalVentaLote) : Math.round(totalWeight * salePricePerUnit);
        const gananciaNetaLote = log.gananciaNetaLote !== undefined ? Number(log.gananciaNetaLote) : Math.round(totalVentaLote - milkCost);
        const gananciaUnitaria = Math.round(salePricePerUnit - costoPorUnidad);

        totalCantinasGeneral += exactCantinas;
        sumaGanancias += gananciaNetaLote;

        const isGood = promedioPorCantina >= customTarget;
        const badgeColor = isGood ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700';
        const profitColor = gananciaNetaLote >= 0 ? 'text-emerald-700 font-black' : 'text-red-600 font-black';
        const unitGainColor = gananciaUnitaria >= 0 ? 'text-sky-700 font-extrabold' : 'text-red-600 font-extrabold';
        const unitGainSign = gananciaUnitaria > 0 ? '+' : '';
        const unitLabel = getYieldUnitSuffix(yieldType);

        tbody.innerHTML += `
            <tr class="border-b border-amber-50 hover:bg-amber-50/30">
                <td class="py-3 px-4">
                    <span class="font-bold text-slate-900">${esc(productName)}</span><br>
                    <span class="font-mono text-[11px] text-slate-500">${log.date}</span>
                </td>
                <td class="py-3 px-4 font-bold text-slate-800">${cantinasText} <span class="text-[11px] text-slate-400">(${liters} L)</span></td>
                <td class="py-3 px-4 font-mono font-bold text-slate-700">${totalWeight} ${unitLabel}</td>
                <td class="py-3 px-4">
                    <span class="px-2.5 py-1 rounded-full text-xs font-bold ${badgeColor}">${promedioPorCantina} ${unitLabel}/cant</span><br>
                    <span class="text-[10px] text-slate-500 font-mono mt-0.5 inline-block">Meta: ${customTarget}</span>
                </td>
                <td class="py-3 px-4 text-right font-mono text-xs">
                    <span class="text-slate-500">Costo Unit: $${costoPorUnidad.toLocaleString('es-CO')}</span><br>
                    <span class="text-emerald-800 font-bold">Venta Unit: $${salePricePerUnit.toLocaleString('es-CO')}</span><br>
                    <span class="${unitGainColor}">Ganancia Unit: ${unitGainSign}$${gananciaUnitaria.toLocaleString('es-CO')} / ${unitLabel}</span>
                </td>
                <td class="py-3 px-4 text-right font-mono ${profitColor}">
                    $${gananciaNetaLote.toLocaleString('es-CO')}<br>
                    <span class="text-[10px] font-normal text-slate-500">Venta: $${totalVentaLote.toLocaleString('es-CO')}</span>
                </td>
                <td class="py-3 px-4 text-right"><button onclick="deleteYieldLog(${log.id})" class="text-xs bg-red-100 hover:bg-red-200 text-red-700 font-bold px-2 py-1 rounded-lg">Eliminar</button></td>
            </tr>`;
    });

    const promedioGanancia = Math.round(sumaGanancias / count);
    document.getElementById('stat-yield-cantinas').innerText = `${totalCantinasGeneral.toFixed(2)} Cantinas`;
    document.getElementById('stat-yield-profit').innerText = `$${promedioGanancia.toLocaleString('es-CO')}`;

    const productNameInput = document.getElementById('yield-product-name');
    if (productNameInput) {
        updateYieldTopCardForSelectedProduct(productNameInput.value);
    }
}

function deleteYieldLog(id) {
    if (confirm("¿Eliminar este registro de rendimiento? Se liberarán los litros para esa fecha.")) {
        state.yieldLogs = state.yieldLogs.filter(y => y.id !== id);
        saveData();
        renderYieldTable();
        onYieldDateChange();
        updateYieldLivePreview();
    }
}

function handleSaleTypeChange() {
    const saleType = document.getElementById('prod-sale-type').value;
    const groupBlocks = document.getElementById('group-blocks');
    const groupUnits = document.getElementById('group-units');
    const labelPrice = document.getElementById('label-price-unit');

    if (saleType === 'kilos') {
        if (groupBlocks) groupBlocks.classList.remove('hidden');
        if (groupUnits) groupUnits.classList.add('hidden');
        if (labelPrice) labelPrice.innerText = 'Precio Base por Kilo ($)';
    } else {
        if (groupBlocks) groupBlocks.classList.add('hidden');
        if (groupUnits) groupUnits.classList.remove('hidden');
        if (labelPrice) labelPrice.innerText = 'Precio Base por Unidad ($)';
    }
}

function addDailyProduction(e) {
    e.preventDefault();
    const productName = document.getElementById('prod-name-entry').value.trim();
    const saleType = document.getElementById('prod-sale-type').value;
    const price = parseFloat(document.getElementById('prod-price-entry').value) || 0;
    const date = document.getElementById('prod-date-entry').value;

    if (!productName || price <= 0 || !date) {
        alert("⚠️ Completa la fecha, el nombre del producto y un precio base mayor a 0.");
        return;
    }

    let product = state.products.find(p => p.name.toLowerCase() === productName.toLowerCase());

    if (saleType === 'kilos') {
        const blocks = parseFloat(document.getElementById('prod-blocks-entry').value) || 0;
        const kilos = parseFloat(document.getElementById('prod-kilos-entry').value) || 0;
        if (kilos <= 0) {
            alert("⚠️ Ingresa el peso total en kilos (mayor a 0).");
            return;
        }

        if (product) {
            product.blocks = (product.blocks || 0) + blocks;
            product.kilos = (product.kilos || 0) + kilos;
            product.pricePerKg = price;
        } else {
            product = { id: Date.now(), name: productName, saleType: 'kilos', blocks, kilos, pricePerKg: price, stockUnits: 0, pricePerUnit: 0 };
            state.products.push(product);
        }
        state.productionLogs.unshift({ id: Date.now(), productName, detail: `+${blocks} blq / +${kilos} kg`, date });
    } else {
        const stockUnits = parseFloat(document.getElementById('prod-units-entry').value) || 0;
        if (stockUnits <= 0) {
            alert("⚠️ Ingresa la cantidad de unidades (mayor a 0).");
            return;
        }

        if (product) {
            product.stockUnits = (product.stockUnits || 0) + stockUnits;
            product.pricePerUnit = price;
        } else {
            product = { id: Date.now(), name: productName, saleType: 'unidad', blocks: 0, kilos: 0, pricePerKg: 0, stockUnits, pricePerUnit: price };
            state.products.push(product);
        }
        state.productionLogs.unshift({ id: Date.now(), productName, detail: `+${stockUnits} unidades`, date });
    }

    saveData();
    document.getElementById('production-form').reset();
    document.getElementById('prod-date-entry').value = getLocalDateString();
    handleSaleTypeChange();
    renderInventoryTable();
    renderProductsPOS();
    renderProductionHistory();
}

function renderInventoryTable() {
    const tbody = document.getElementById('inventory-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (state.products.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center py-6 text-slate-400 font-medium">No hay productos.</td></tr>';
        return;
    }

    state.products.forEach(p => {
        let stockText = p.saleType === 'kilos' ? `${p.blocks || 0} blq (${p.kilos} kg)` : `${p.stockUnits} unidades`;
        let priceText = p.saleType === 'kilos' ? `$${p.pricePerKg.toLocaleString('es-CO')} / kg` : `$${p.pricePerUnit.toLocaleString('es-CO')} / und`;

        tbody.innerHTML += `
            <tr class="border-b border-emerald-50">
                <td class="py-3 px-4 font-bold text-slate-800">${esc(p.name)}</td>
                <td class="py-3 px-4 font-mono text-emerald-700 font-bold">${priceText}</td>
                <td class="py-3 px-4 font-mono font-bold text-slate-700">${stockText}</td>
                <td class="py-3 px-4 text-right">
                    <button onclick="deleteProduct(${p.id})" class="text-xs bg-red-100 hover:bg-red-200 text-red-700 font-bold px-2 py-1 rounded-lg mr-1">Eliminar</button>
                    <button onclick="editProductPrice(${p.id})" class="text-xs bg-emerald-100 hover:bg-emerald-200 text-emerald-800 font-bold px-2.5 py-1 rounded-lg">Precio</button>
                </td>
            </tr>`;
    });
}

function deleteProduct(id) {
    if (confirm("¿Eliminar producto?")) {
        state.products = state.products.filter(p => p.id !== id);
        saveData();
        renderInventoryTable();
        renderProductsPOS();
    }
}

function editProductPrice(id) {
    const p = state.products.find(item => item.id === id);
    if (!p) return;
    const cur = p.saleType === 'kilos' ? p.pricePerKg : p.pricePerUnit;
    const np = prompt(`Nuevo precio base para ${p.name}:`, cur);
    if (np === null) return;
    const newPrice = parseNumericInput(np);
    if (newPrice <= 0) {
        alert("⚠️ Ingresa un precio válido mayor a 0.");
        return;
    }
    {
        if (p.saleType === 'kilos') p.pricePerKg = newPrice;
        else p.pricePerUnit = newPrice;
        saveData();
        renderInventoryTable();
        renderProductsPOS();
    }
}

function renderProductionHistory() {
    const container = document.getElementById('production-history-list');
    if (!container) return;
    container.innerHTML = '';
    state.productionLogs.slice(0, 10).forEach(log => {
        container.innerHTML += `<div class="flex justify-between items-center bg-emerald-50/60 p-2.5 rounded-xl text-xs border border-emerald-100"><div><p class="font-bold text-emerald-950">${esc(log.productName)}</p><p class="text-[10px] text-slate-500">${log.date}</p></div><span class="font-mono font-bold text-emerald-700 bg-white px-2 py-1 rounded-lg">${esc(log.detail)}</span></div>`;
    });
}

function renderProductsPOS() {
    const grid = document.getElementById('product-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (state.products.length === 0) {
        grid.innerHTML = '<p class="text-slate-400 text-sm col-span-full text-center py-6">No hay stock disponible.</p>';
        return;
    }

    const client = getSelectedClient();
    state.products.forEach(p => {
        const isAvailable = p.saleType === 'kilos' ? p.kilos > 0 : p.stockUnits > 0;
        const stockBadge = p.saleType === 'kilos' ? `Stock: ${p.blocks || 0} blq (${p.kilos} kg)` : `Stock: ${p.stockUnits} und`;
        const unitSuffix = p.saleType === 'kilos' ? 'kg' : 'und';
        const basePrice = getBasePrice(p);
        const clientPrice = client ? getClientPrice(client, p) : basePrice;
        const hasSpecial = client && clientPrice !== basePrice;
        const priceHtml = hasSpecial
            ? `<p class="text-base font-black text-emerald-700 mt-1">$${clientPrice.toLocaleString('es-CO')} / ${unitSuffix}</p>
               <p class="text-[11px] text-slate-500">Precio de ${esc(client.name)} · Base: $${basePrice.toLocaleString('es-CO')}</p>`
            : `<p class="text-base font-black text-emerald-700 mt-1">$${basePrice.toLocaleString('es-CO')} / ${unitSuffix}</p>
               <p class="text-[11px] text-slate-500">Precio base</p>`;

        grid.innerHTML += `
            <div class="bg-white border border-emerald-100 rounded-xl p-4 flex flex-col justify-between shadow-sm">
                <div>
                    <span class="text-[10px] font-bold ${isAvailable ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'} px-2 py-0.5 rounded-full uppercase">${stockBadge}</span>
                    <h4 class="font-bold text-slate-800 mt-2 text-sm">${esc(p.name)}</h4>
                    ${priceHtml}
                </div>
                <button onclick="promptSellProduct(${p.id})" ${!isAvailable ? 'disabled' : ''} class="mt-3 w-full ${isAvailable ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-slate-200 text-slate-400 cursor-not-allowed'} font-bold py-2 rounded-lg text-xs">
                    ${isAvailable ? 'Vender' : 'Sin Stock'}
                </button>
            </div>`;
    });
    if (window.lucide) lucide.createIcons();
}

function getSelectedClient() {
    const select = document.getElementById('client-select');
    if (!select || !select.value) return null;
    return state.clients.find(c => String(c.id) === String(select.value)) || null;
}

function getBasePrice(product) {
    return product.saleType === 'kilos' ? (product.pricePerKg || 0) : (product.pricePerUnit || 0);
}

function getClientPrice(client, product) {
    const special = client && client.prices ? Number(client.prices['p_' + product.id]) : 0;
    return special > 0 ? special : getBasePrice(product);
}

function onClientSelectChange() {
    const client = getSelectedClient();
    // Si ya hay productos en el carrito, se recalculan con los precios del comprador elegido
    state.cart.forEach(item => {
        const product = state.products.find(p => p.id === item.id);
        if (product) item.price = getClientPrice(client, product);
    });
    renderProductsPOS();
    renderCart();
}

function promptSellProduct(productId) {
    const product = state.products.find(p => p.id === productId);
    if (!product) return;

    const client = getSelectedClient();
    if (!client) {
        alert("⚠️ Primero selecciona el comprador (paso 1): cada comprador tiene su propio precio.");
        return;
    }

    const isKilos = product.saleType === 'kilos';
    const inCart = state.cart.filter(i => i.id === product.id)
        .reduce((acc, i) => acc + (isKilos ? i.kilos : i.units), 0);
    const available = (isKilos ? product.kilos : product.stockUnits) - inCart;
    const unitName = isKilos ? 'kilos' : 'unidades';

    const inputQty = prompt(`¿Cuántos ${unitName} de "${product.name}" vas a vender a ${client.name}? (Disponible: ${available})`, "1");
    if (inputQty === null) return;
    const qty = parseNumericInput(inputQty);
    if (qty <= 0 || qty > available) {
        alert(`⚠️ Cantidad no válida. Disponible: ${available} ${unitName}.`);
        return;
    }

    let blocks = 0;
    if (isKilos) {
        const inputBlocks = prompt(`¿Cuántos bloques físicos equivalentes se entregan? (Stock: ${product.blocks || 0} blq):`, "1");
        blocks = inputBlocks !== null ? parseNumericInput(inputBlocks) : 0;
    }

    const basePrice = getBasePrice(product);
    const suggested = getClientPrice(client, product);
    const priceLabel = isKilos ? 'por kilo' : 'por unidad';
    const inputPrice = prompt(`Precio ${priceLabel} para ${client.name}\n(Precio base: $${basePrice.toLocaleString('es-CO')})`, suggested);
    if (inputPrice === null) return;
    const price = parseNumericInput(inputPrice);
    if (price <= 0) {
        alert("⚠️ El precio debe ser mayor a 0.");
        return;
    }

    if (price !== suggested) {
        if (confirm(`¿Guardar $${price.toLocaleString('es-CO')} como precio de ${client.name} para "${product.name}"?\n\nAceptar = queda guardado para próximas ventas.\nCancelar = solo aplica a esta venta.`)) {
            client.prices = client.prices || {};
            if (price === basePrice) delete client.prices['p_' + product.id];
            else client.prices['p_' + product.id] = price;
            saveData();
            renderProductsPOS();
        }
    }

    state.cart.push({
        id: product.id, name: product.name, saleType: product.saleType, price, basePrice,
        kilos: isKilos ? qty : 0, blocksEquivalent: blocks, units: isKilos ? 0 : qty
    });
    renderCart();
}

function renderCart() {
    const cartContainer = document.getElementById('cart-items');
    if (!cartContainer) return;

    if (state.cart.length === 0) {
        cartContainer.innerHTML = '<p class="text-emerald-400/60 text-center text-sm py-6">No has agregado productos.</p>';
        document.getElementById('cart-total').innerText = '$0';
        calculateChange();
        return;
    }

    cartContainer.innerHTML = '';
    let total = 0;
    state.cart.forEach((item, index) => {
        let itemTotal = item.saleType === 'kilos' ? (item.price * item.kilos) : (item.price * item.units);
        total += itemTotal;
        let desc = item.saleType === 'kilos' ? `${item.kilos}kg (${item.blocksEquivalent || 0} blq)` : `${item.units} und`;

        cartContainer.innerHTML += `
            <div class="flex items-center justify-between bg-emerald-900/60 p-2.5 rounded-xl text-xs border border-emerald-800 text-white gap-2">
                <div class="flex-1">
                    <p class="font-bold">${esc(item.name)}</p>
                    <p class="text-emerald-300">${desc} — <span class="font-mono font-bold">$${itemTotal.toLocaleString('es-CO')}</span></p>
                </div>
                <button onclick="removeFromCart(${index})" class="text-red-400 hover:text-red-300 bg-emerald-950/80 p-1.5 rounded-lg transition-colors" title="Eliminar producto">
                    <i data-lucide="trash-2" class="w-4 h-4"></i>
                </button>
            </div>`;
    });

    document.getElementById('cart-total').innerText = `$${total.toLocaleString('es-CO')}`;
    calculateChange();
    if (window.lucide) lucide.createIcons();
}

function removeFromCart(index) {
    state.cart.splice(index, 1);
    renderCart();
}

function calculateChange() {
    const total = state.cart.reduce((acc, i) => acc + (i.saleType === 'kilos' ? (i.price * i.kilos) : (i.price * i.units)), 0);
    const received = parseFloat(document.getElementById('received-amount').value) || 0;
    const diff = received - total;

    const changeEl = document.getElementById('change-amount');
    const labelChangeText = document.getElementById('label-change-text');
    if (!changeEl || !labelChangeText) return;

    const client = getSelectedClient();
    const pending = client
        ? state.clientDebts.filter(d => String(d.clientId) === String(client.id) && d.status === 'pendiente')
            .reduce((acc, d) => acc + Math.max(0, d.totalAmount - d.paidAmount), 0)
        : 0;

    if (diff > 0 && pending > 0) {
        const abono = Math.min(diff, pending);
        labelChangeText.innerText = `Abona a deuda $${abono.toLocaleString('es-CO')} · Cambio:`;
        changeEl.innerText = `$${(diff - abono).toLocaleString('es-CO')}`;
        changeEl.className = "text-lg font-mono font-bold text-emerald-400";
    } else if (diff >= 0) {
        labelChangeText.innerText = "Cambio / Vueltas:";
        changeEl.innerText = `$${diff.toLocaleString('es-CO')}`;
        changeEl.className = "text-lg font-mono font-bold text-emerald-400";
    } else {
        labelChangeText.innerText = "Queda Fiado (Deuda):";
        changeEl.innerText = `$${Math.abs(diff).toLocaleString('es-CO')}`;
        changeEl.className = "text-lg font-mono font-bold text-amber-400";
    }
}

function processSaleAndPrint() {
    const clientId = document.getElementById('client-select').value;
    if (!clientId) {
        alert("⚠️ Por favor selecciona un comprador en la sección '1. Seleccionar Comprador'.");
        return;
    }
    if (state.cart.length === 0) {
        alert("⚠️ El resumen de venta está vacío. Agrega al menos un producto.");
        return;
    }

    const client = state.clients.find(c => c.id == clientId);
    const paymentMethod = document.getElementById('payment-method').value;
    const totalVenta = state.cart.reduce((acc, i) => acc + (i.saleType === 'kilos' ? (i.price * i.kilos) : (i.price * i.units)), 0);
    const dineroRecibido = parseFloat(document.getElementById('received-amount').value) || 0;

    // Validar stock total por producto (el mismo producto puede estar en varias líneas)
    const needed = {};
    state.cart.forEach(i => {
        needed[i.id] = needed[i.id] || { kilos: 0, units: 0 };
        needed[i.id].kilos += i.kilos || 0;
        needed[i.id].units += i.units || 0;
    });
    for (const id of Object.keys(needed)) {
        const p = state.products.find(x => String(x.id) === id);
        if (!p) continue;
        const short = p.saleType === 'kilos' ? needed[id].kilos > p.kilos + 1e-9 : needed[id].units > p.stockUnits;
        if (short) {
            alert(`⚠️ No hay stock suficiente de "${p.name}" para esta venta. Quita o reduce cantidades.`);
            return;
        }
    }

    state.cart.forEach(item => {
        const product = state.products.find(p => p.id === item.id);
        if (product) {
            if (product.saleType === 'kilos') {
                product.kilos = Math.max(0, parseFloat((product.kilos - item.kilos).toFixed(2)));
                product.blocks = Math.max(0, parseFloat(((product.blocks || 0) - item.blocksEquivalent).toFixed(2)));
            } else {
                product.stockUnits = Math.max(0, product.stockUnits - item.units);
            }
        }
    });

    let dineroEntraCaja = 0;
    let montoFiado = 0;
    let abonoADeudas = 0;
    let cambioReal = 0;
    const abonosAplicados = [];
    const hoyISO = getLocalDateString();

    if (dineroRecibido < totalVenta) {
        montoFiado = totalVenta - dineroRecibido;
        dineroEntraCaja = dineroRecibido;

        const itemsSummary = state.cart.map(i => i.saleType === 'kilos'
            ? `${i.kilos}kg ${i.name}`
            : `${i.units} und ${i.name}`).join(', ');

        state.clientDebts.push({
            id: Date.now(),
            clientId: client.id,
            clientName: client.name,
            date: hoyISO,
            concept: `Venta Directa: ${itemsSummary}`,
            items: state.cart.map(i => ({ ...i })),
            totalVentaOriginal: totalVenta,
            abonoInicial: dineroRecibido,
            totalAmount: montoFiado,
            paidAmount: 0,
            status: 'pendiente'
        });
    } else {
        dineroEntraCaja = totalVenta;
        let excedente = dineroRecibido - totalVenta;

        // El sobrante abona primero a las deudas más antiguas; lo que no se use es el cambio real
        const clientPendings = state.clientDebts.filter(d => d.clientId == client.id && d.status === 'pendiente');
        clientPendings.sort((a, b) => a.id - b.id);

        for (const debt of clientPendings) {
            if (excedente <= 0) break;
            const saldoDeuda = debt.totalAmount - debt.paidAmount;
            const aplicado = Math.min(excedente, saldoDeuda);
            if (aplicado <= 0) continue;
            debt.paidAmount += aplicado;
            if (debt.paidAmount >= debt.totalAmount) debt.status = 'pagado';
            excedente -= aplicado;
            abonoADeudas += aplicado;
            abonosAplicados.push({ debt, aplicado });
        }
        cambioReal = excedente;
    }

    if (dineroEntraCaja > 0) {
        state.salesHistory.unshift({
            id: Date.now(),
            date: new Date().toLocaleString('es-CO'),
            rawDate: hoyISO,
            clientName: client.name,
            paymentMethod,
            items: [...state.cart],
            total: dineroEntraCaja,
            totalVentaOriginal: totalVenta
        });
    }

    // Cada abono a una deuda vieja también es dinero que entra a la caja
    abonosAplicados.forEach(({ debt, aplicado }, idx) => {
        state.salesHistory.unshift({
            id: Date.now() + idx + 1,
            date: new Date().toLocaleString('es-CO'),
            rawDate: hoyISO,
            clientName: client.name,
            paymentMethod,
            items: [{ name: `Abono a Factura (${debt.date} - ${debt.concept})`, saleType: 'unidad', units: 1, price: aplicado }],
            total: aplicado,
            isAbono: true
        });
    });

    saveData();

    const fechaActual = new Date().toLocaleString('es-CO');
    lastReceiptData = {
        company: state.companyName.toUpperCase(),
        date: fechaActual,
        client: client.name,
        paymentMethod,
        items: state.cart.map(item => ({
            name: item.name,
            desc: item.saleType === 'kilos' ? `${item.kilos}kg / ${item.blocksEquivalent || 0}blq` : `${item.units} und`,
            subtotal: item.saleType === 'kilos' ? item.price * item.kilos : item.price * item.units
        })),
        totalVenta,
        dineroRecibido,
        montoFiado,
        abonoADeudas,
        cambioReal
    };

    document.getElementById('receipt-company').innerText = lastReceiptData.company;
    document.getElementById('receipt-date').innerText = fechaActual;
    document.getElementById('receipt-client').innerText = client.name;
    document.getElementById('receipt-payment-method').innerText = paymentMethod;

    const tbody = document.getElementById('receipt-items-body');
    tbody.innerHTML = '';
    lastReceiptData.items.forEach(item => {
        tbody.innerHTML += `<tr><td>${esc(item.name)} (${esc(item.desc)})</td><td class="text-right font-bold">$${item.subtotal.toLocaleString('es-CO')}</td></tr>`;
    });

    document.getElementById('receipt-total').innerText = `$${totalVenta.toLocaleString('es-CO')}`;
    document.getElementById('receipt-received').innerText = `$${dineroRecibido.toLocaleString('es-CO')}`;

    const receiptChangeRow = document.getElementById('receipt-change-row');
    const receiptDebtRow = document.getElementById('receipt-debt-row');
    const receiptAbonoRow = document.getElementById('receipt-abono-row');
    if (receiptAbonoRow) {
        receiptAbonoRow.style.display = abonoADeudas > 0 ? 'flex' : 'none';
        document.getElementById('receipt-abono').innerText = `$${abonoADeudas.toLocaleString('es-CO')}`;
    }

    if (dineroRecibido >= totalVenta) {
        receiptChangeRow.style.display = 'flex';
        receiptDebtRow.style.display = 'none';
        document.getElementById('receipt-change').innerText = `$${cambioReal.toLocaleString('es-CO')}`;
    } else {
        receiptChangeRow.style.display = 'none';
        receiptDebtRow.style.display = 'flex';
        document.getElementById('receipt-debt').innerText = `$${montoFiado.toLocaleString('es-CO')}`;
    }

    document.getElementById('modal-receipt').classList.remove('hidden');
    document.getElementById('modal-receipt').classList.add('flex');

    renderProductsPOS();
    renderInventoryTable();
    renderSalesHistory();
    renderMonthlyBalance();
    renderClientAccountsTable();

    state.cart = [];
    document.getElementById('received-amount').value = '';
    renderCart();
}

function renderSalesHistory() {
    const tbody = document.getElementById('sales-history-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    const todayStr = getLocalDateString();
    let totalIngresadoHoy = 0, totalNequiHoy = 0, totalEfectivoHoy = 0, totalGastosHoy = 0;

    state.salesHistory.forEach(sale => {
        if ((sale.rawDate || sale.date) === todayStr) {
            totalIngresadoHoy += sale.total;
            if (sale.paymentMethod === 'Nequi') totalNequiHoy += sale.total;
            else if (sale.paymentMethod === 'Efectivo') totalEfectivoHoy += sale.total;
        }
    });

    state.expenses.forEach(exp => {
        if (exp.date === todayStr) totalGastosHoy += exp.amount;
    });

    const efectivoRealEnCaja = totalEfectivoHoy - totalGastosHoy;

    if (state.salesHistory.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center py-6 text-slate-400 font-medium">No hay ingresos registrados hoy.</td></tr>';
    } else {
        state.salesHistory.forEach(sale => {
            const itemsDesc = sale.isAbono
                ? `<span class="font-bold text-amber-800">${esc(sale.items[0].name)}</span>`
                : sale.items.map(i => i.saleType === 'kilos' ? `${i.kilos}kg de ${esc(i.name)}` : `${i.units} und de ${esc(i.name)}`).join(' | ');

            tbody.innerHTML += `
                <tr class="border-b border-emerald-50 hover:bg-emerald-50/20">
                    <td class="py-3 px-4 font-mono text-xs text-slate-500">${sale.date}</td>
                    <td class="py-3 px-4 font-bold text-slate-800">${esc(sale.clientName)}</td>
                    <td class="py-3 px-4 text-slate-700 text-xs">${itemsDesc}</td>
                    <td class="py-3 px-4"><span class="px-2.5 py-1 rounded-full text-xs font-bold ${sale.paymentMethod === 'Efectivo' ? 'bg-emerald-100 text-emerald-800' : 'bg-sky-100 text-sky-800'}">${sale.paymentMethod}</span></td>
                    <td class="py-3 px-4 text-right font-mono font-black text-emerald-700">+$${sale.total.toLocaleString('es-CO')}</td>
                </tr>`;
        });
    }

    const statTotalHoy = document.getElementById('stat-total-hoy');
    const statTotalNequi = document.getElementById('stat-total-nequi');
    const statTotalGastos = document.getElementById('stat-total-gastos');
    const statEfectivoCaja = document.getElementById('stat-efectivo-caja');

    if (statTotalHoy) statTotalHoy.innerText = `$${totalIngresadoHoy.toLocaleString('es-CO')}`;
    if (statTotalNequi) statTotalNequi.innerText = `$${totalNequiHoy.toLocaleString('es-CO')}`;
    if (statTotalGastos) statTotalGastos.innerText = `-$${totalGastosHoy.toLocaleString('es-CO')}`;
    if (statEfectivoCaja) statEfectivoCaja.innerText = `$${efectivoRealEnCaja.toLocaleString('es-CO')}`;
}

function renderMonthlyBalance() {
    let totalVentasMes = 0, totalNequiMes = 0, totalGastosMes = 0;
    let transactions = [];

    const monthInput = document.getElementById('balance-month');
    if (monthInput && !monthInput.value) monthInput.value = getLocalDateString().slice(0, 7);
    const selectedMonth = monthInput ? monthInput.value : getLocalDateString().slice(0, 7);
    const inMonth = (rawDate) => toISODate(rawDate).slice(0, 7) === selectedMonth;

    // 1. Ventas y Abonos (Módulo 2 / Módulo 1)
    state.salesHistory.forEach(s => {
        if (!inMonth(s.rawDate || s.date)) return;
        totalVentasMes += s.total;
        if (s.paymentMethod === 'Nequi') totalNequiMes += s.total;

        const desc = s.isAbono
            ? s.items[0].name
            : s.items.map(i => i.saleType === 'kilos' ? `${i.kilos}kg ${i.name}` : `${i.units} und ${i.name}`).join(', ');

        transactions.push({
            date: s.rawDate || s.date,
            module: s.isAbono ? 'Módulo 1: Cuentas por Cobrar' : 'Módulo 2: POS Ventas',
            concept: `Comprador: ${s.clientName} — ${desc} (${s.paymentMethod})`,
            type: 'Ingreso',
            amount: s.total,
            sortId: s.id || 0
        });
    });

    // 2. Pagos a Proveedores de Leche (Módulo 4: Acopio)
    state.milkPayments.forEach(p => {
        if (!inMonth(p.date)) return;
        totalGastosMes += p.totalPaid;
        transactions.push({
            date: p.date,
            module: 'Módulo 4: Acopio de Leche',
            concept: `Pago Quincena a ${p.providerName}: ${p.liters} Litros @ $${(p.pricePerLiter || 0).toLocaleString('es-CO')}/L`,
            type: 'Egreso',
            amount: p.totalPaid,
            sortId: p.id || 0
        });
    });

    // 3. Gastos e Inversiones (Excluyendo duplicados de pagos de leche)
    state.expenses.forEach(e => {
        if (e.name.startsWith('Pago Quincena Leche')) return;
        if (!inMonth(e.date)) return;

        totalGastosMes += e.amount;
        transactions.push({
            date: e.date,
            module: 'Módulo de Gastos / Inversión',
            concept: e.name,
            type: 'Egreso',
            amount: e.amount,
            sortId: e.id || 0
        });
    });

    transactions.sort((a, b) => b.sortId - a.sortId);

    const mTotalSales = document.getElementById('monthly-total-sales');
    const mTotalNequi = document.getElementById('monthly-total-nequi');
    const mTotalExpenses = document.getElementById('monthly-total-expenses');
    const mNetProfit = document.getElementById('monthly-net-profit');
    const detailedBody = document.getElementById('monthly-detailed-transactions-body');

    if (mTotalSales) mTotalSales.innerText = `$${totalVentasMes.toLocaleString('es-CO')}`;
    if (mTotalNequi) mTotalNequi.innerText = `$${totalNequiMes.toLocaleString('es-CO')}`;
    if (mTotalExpenses) mTotalExpenses.innerText = `-$${totalGastosMes.toLocaleString('es-CO')}`;
    if (mNetProfit) mNetProfit.innerText = `$${(totalVentasMes - totalGastosMes).toLocaleString('es-CO')}`;

    if (detailedBody) {
        detailedBody.innerHTML = '';
        if (transactions.length === 0) {
            detailedBody.innerHTML = '<tr><td colspan="5" class="text-center py-6 text-slate-400 font-medium">No hay transacciones en el mes seleccionado.</td></tr>';
        } else {
            transactions.forEach(tx => {
                const isIngreso = tx.type === 'Ingreso';
                const badgeClass = isIngreso ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700';
                const amountClass = isIngreso ? 'text-emerald-700 font-black' : 'text-red-600 font-black';
                const sign = isIngreso ? '+' : '-';

                detailedBody.innerHTML += `
                    <tr class="border-b border-emerald-50 hover:bg-emerald-50/20">
                        <td class="py-3 px-4 font-mono text-xs text-slate-500">${tx.date}</td>
                        <td class="py-3 px-4 font-bold text-slate-900 text-xs">${tx.module}</td>
                        <td class="py-3 px-4 text-slate-700 text-xs">${esc(tx.concept)}</td>
                        <td class="py-3 px-4"><span class="px-2.5 py-1 rounded-full text-xs font-bold ${badgeClass}">${tx.type}</span></td>
                        <td class="py-3 px-4 text-right font-mono ${amountClass}">${sign}$${tx.amount.toLocaleString('es-CO')}</td>
                    </tr>`;
            });
        }
    }
}

function clearSalesHistory() {
    const typed = prompt("⚠️ Esto borra TODO el historial de ingresos (de todos los meses) y cambia el balance.\n\nPara confirmar escribe BORRAR:");
    if (typed !== null && typed.trim().toUpperCase() === 'BORRAR') {
        state.salesHistory = [];
        saveData();
        renderSalesHistory();
        renderMonthlyBalance();
    }
}

function closeReceiptModal() {
    document.getElementById('modal-receipt').classList.add('hidden');
    document.getElementById('modal-receipt').classList.remove('flex');
}

function triggerPrint() {
    const isAndroid = /Android/i.test(navigator.userAgent);

    if (isAndroid && lastReceiptData) {
        const line = "--------------------------------";
        let ticket = "";
        ticket += `      ${lastReceiptData.company}\n`;
        ticket += "  Comprobante de Venta Directa\n";
        ticket += `  ${lastReceiptData.date}\n`;
        ticket += `${line}\n`;
        ticket += `Cliente: ${lastReceiptData.client}\n`;
        ticket += `Pago: ${lastReceiptData.paymentMethod}\n`;
        ticket += `${line}\n`;

        lastReceiptData.items.forEach(it => {
            ticket += `${it.name} (${it.desc})\n`;
            ticket += `                  $${it.subtotal.toLocaleString('es-CO')}\n`;
        });

        ticket += `${line}\n`;
        ticket += `TOTAL VENTA:      $${lastReceiptData.totalVenta.toLocaleString('es-CO')}\n`;
        ticket += `Dinero Ingresado: $${lastReceiptData.dineroRecibido.toLocaleString('es-CO')}\n`;

        if (lastReceiptData.dineroRecibido >= lastReceiptData.totalVenta) {
            if (lastReceiptData.abonoADeudas > 0) {
                ticket += `Abono a deudas:   $${lastReceiptData.abonoADeudas.toLocaleString('es-CO')}\n`;
            }
            ticket += `Cambio / Vueltas: $${lastReceiptData.cambioReal.toLocaleString('es-CO')}\n`;
        } else {
            ticket += `Quedo Fiado:      $${lastReceiptData.montoFiado.toLocaleString('es-CO')}\n`;
        }

        ticket += `${line}\n`;
        ticket += "    Gracias por su compra!\n";
        ticket += "  Producto Fresco de Calidad\n\n\n\n";

        const cleanTicket = ticket.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        window.location.href = "rawbt:" + encodeURIComponent(cleanTicket);
    } else {
        window.print();
    }
}

function openConfigModal() {
    document.getElementById('modal-company-name-input').value = state.companyName;
    document.getElementById('modal-config').classList.remove('hidden');
    document.getElementById('modal-config').classList.add('flex');
}

function closeConfigModal() {
    document.getElementById('modal-config').classList.add('hidden');
    document.getElementById('modal-config').classList.remove('flex');
}

async function saveCompanyName() {
    const newName = document.getElementById('modal-company-name-input').value.trim();
    if (newName) {
        state.companyName = newName;
        saveData();
        document.getElementById('app-company-name').innerText = newName;
        document.getElementById('receipt-company').innerText = newName.toUpperCase();
        if (state.currentUserEmail) {
            const existing = await fetchRegisteredUser(state.currentUserEmail);
            if (existing) {
                existing.companyName = newName;
                await persistRegisteredUser(existing);
            }
        }
    }
    closeConfigModal();
}

function switchModule(modName) {
    if (state.currentUserRole === 'conductor') {
        modName = 'leche';
    }

    const views = ['cuentas', 'ventas', 'historial', 'gastos', 'inventario', 'leche', 'vehiculos', 'contabilidad'];
    views.forEach(v => {
        const viewEl = document.getElementById(`view-${v}`);
        const btnEl = document.getElementById(`mod-btn-${v}`);
        if (viewEl && btnEl) {
            if (v === modName) {
                viewEl.classList.remove('hidden');
                btnEl.className = "mod-btn active border-b-2 border-emerald-600 text-emerald-800 font-bold px-4 py-2 text-sm flex items-center space-x-2 whitespace-nowrap bg-emerald-50/50 rounded-t-lg";
            } else {
                viewEl.classList.add('hidden');
                btnEl.className = "mod-btn text-slate-500 font-medium px-4 py-2 text-sm flex items-center space-x-2 whitespace-nowrap hover:text-emerald-700 transition-colors";
            }
        }
    });

    if (modName === 'cuentas') {
        renderClientAccountsTable();
        renderPastDebtClientSelect();
    }

    if (modName === 'leche') {
        const dateInput = document.getElementById('daily-milk-date');
        if (dateInput && !dateInput.value) dateInput.value = getLocalDateString();
        renderMilkProvidersSelect();
        renderProvidersTable();
        renderMilkPaymentsTable();
        renderDailyMilkTable();

        if (state.currentUserRole === 'conductor') {
            const tabsContainer = document.getElementById('milk-tabs-container');
            if (tabsContainer) tabsContainer.classList.add('hidden');
            const secProv = document.getElementById('milk-section-proveedores');
            const secPagos = document.getElementById('milk-section-pagos');
            if (secProv) secProv.classList.add('hidden');
            if (secPagos) secPagos.classList.add('hidden');
            const secReg = document.getElementById('milk-section-registro');
            if (secReg) secReg.classList.remove('hidden');
        }
    }

    if (modName === 'vehiculos') {
        const yieldDateInput = document.getElementById('yield-date');
        if (yieldDateInput && !yieldDateInput.value) yieldDateInput.value = getLocalDateString();
        onYieldDateChange();
        onYieldProductSelectChange();
        renderYieldTable();
        updateYieldLivePreview();
    }

    const defaultDateFields = { gastos: 'exp-date-entry', inventario: 'prod-date-entry', cuentas: 'past-debt-date' };
    if (defaultDateFields[modName]) {
        const dateField = document.getElementById(defaultDateFields[modName]);
        if (dateField && !dateField.value) dateField.value = getLocalDateString();
    }

    if (modName === 'contabilidad') {
        renderMonthlyBalance();
    }
}

// EXPORTAR FUNCIONES AL ÁMBITO GLOBAL
window.switchAuthTab = switchAuthTab;
window.handleAuthSubmit = handleAuthSubmit;
window.handleRegisterRoleChange = handleRegisterRoleChange;
window.checkPasswordStrength = checkPasswordStrength;
window.switchModule = switchModule;
window.toggleNewClientForm = toggleNewClientForm;
window.saveClient = saveClient;
window.renderPastDebtClientSelect = renderPastDebtClientSelect;
window.addPastDebt = addPastDebt;
window.toggleDebtDetails = toggleDebtDetails;
window.addExpense = addExpense;
window.deleteExpense = deleteExpense;
window.switchMilkTab = switchMilkTab;
window.addMilkProvider = addMilkProvider;
window.payProviderQuincena = payProviderQuincena;
window.editProviderPrice = editProviderPrice;
window.deleteProvider = deleteProvider;
window.addDailyMilk = addDailyMilk;
window.deleteDailyMilk = deleteDailyMilk;
window.resetQuincena = resetQuincena;
window.handleSaleTypeChange = handleSaleTypeChange;
window.addDailyProduction = addDailyProduction;
window.deleteProduct = deleteProduct;
window.editProductPrice = editProductPrice;
window.promptSellProduct = promptSellProduct;
window.removeFromCart = removeFromCart;
window.calculateChange = calculateChange;
window.processSaleAndPrint = processSaleAndPrint;
window.clearSalesHistory = clearSalesHistory;
window.closeReceiptModal = closeReceiptModal;
window.triggerPrint = triggerPrint;
window.openConfigModal = openConfigModal;
window.closeConfigModal = closeConfigModal;
window.saveCompanyName = saveCompanyName;
window.logout = logout;
window.onYieldDateChange = onYieldDateChange;
window.onYieldProductSelectChange = onYieldProductSelectChange;
window.onYieldProductNameInput = onYieldProductNameInput;
window.onYieldTargetInput = onYieldTargetInput;
window.onYieldLitersInput = onYieldLitersInput;
window.handleYieldTypeChange = handleYieldTypeChange;
window.updateYieldLivePreview = updateYieldLivePreview;
window.addYieldLog = addYieldLog;
window.deleteYieldLog = deleteYieldLog;
window.promptPaySpecificDebt = promptPaySpecificDebt;
window.deleteDebtRecord = deleteDebtRecord;
window.renderMilkPaymentsTable = renderMilkPaymentsTable;
window.deleteMilkPayment = deleteMilkPayment;
window.onClientSelectChange = onClientSelectChange;
window.renderMonthlyBalance = renderMonthlyBalance;