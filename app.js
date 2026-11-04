// Importar los SDKs necesarios de Firebase (versión modular 13.2.0)
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import { getDatabase, ref, set, onValue } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-database.js";

// Credenciales oficiales de tu nuevo proyecto en Firebase
const firebaseConfig = {
    apiKey: "AIzaSyAXWC6FgkeLlOtzH4_gPTwkRQzKrbAPCkE",
    authDomain: "lacteosvictoria-2b574.firebaseapp.com",
    projectId: "lacteosvictoria-2b574",
    storageBucket: "lacteosvictoria-2b574.appfirebasestorage.app",
    messagingSenderId: "1010099938727",
    appId: "1:1010099938727:web:4ad61b1e0ae7cb98768282",
    measurementId: "G-NB2W7V2TGB"
};

// Inicializar Firebase y la Base de Datos en Tiempo Real
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const STORAGE_KEY = 'lacteos_app_master_db';

// ESTADO GENERAL DE LA APLICACIÓN
let state = {
    companyName: 'Lácteos Victoria',
    authMode: 'login',
    currentUserRole: 'admin', // 'admin' (Dueño) o 'conductor' (Recolector)
    registeredUsers: [], 
    currentUserEmail: null,
    clients: [], 
    products: [], 
    productionLogs: [], 
    salesHistory: [], 
    expenses: [], 
    milkProviders: [], 
    dailyMilkLogs: [], 
    cart: []
};

// CARGAR DATOS DESDE LA NUBE EN TIEMPO REAL
function loadSavedDataFromCloud() {
    const dbRef = ref(db, STORAGE_KEY);
    onValue(dbRef, (snapshot) => {
        const parsed = snapshot.val();
        if (parsed) {
            state.companyName = parsed.companyName || state.companyName;
            state.registeredUsers = parsed.registeredUsers || [];
            state.clients = parsed.clients || [];
            state.products = parsed.products || [];
            state.productionLogs = parsed.productionLogs || [];
            state.salesHistory = parsed.salesHistory || [];
            state.expenses = parsed.expenses || [];
            state.milkProviders = parsed.milkProviders || [];
            state.dailyMilkLogs = parsed.dailyMilkLogs || [];

            // Refrescar vistas en tiempo real si la sesión está activa
            if (document.getElementById('main-app') && !document.getElementById('main-app').classList.contains('hidden')) {
                renderClientSelect();
                renderProductsPOS();
                renderInventoryTable();
                renderProductionHistory();
                renderSalesHistory();
                renderExpensesTable();
                renderMilkProvidersSelect();
                renderProvidersTable();
                renderDailyMilkTable();
                renderMonthlyBalance();
            }
        }
    });
}

// GUARDAR DATOS AUTOMÁTICAMENTE EN LA NUBE
function saveData() {
    const dataToSave = {
        companyName: state.companyName,
        registeredUsers: state.registeredUsers,
        clients: state.clients,
        products: state.products,
        productionLogs: state.productionLogs,
        salesHistory: state.salesHistory,
        expenses: state.expenses,
        milkProviders: state.milkProviders,
        dailyMilkLogs: state.dailyMilkLogs
    };
    
    set(ref(db, STORAGE_KEY), dataToSave).catch((error) => {
        console.error("Error al sincronizar con Firebase:", error);
    });
}

// AL CARGAR LA PÁGINA
document.addEventListener('DOMContentLoaded', () => {
    loadSavedDataFromCloud();
    if (window.lucide) lucide.createIcons();
    updateDateDisplay();

    const titleEl = document.getElementById('display-company-title');
    const appNameEl = document.getElementById('app-company-name');
    const receiptCompanyEl = document.getElementById('receipt-company');

    if (titleEl) titleEl.innerText = state.companyName;
    if (appNameEl) appNameEl.innerText = state.companyName;
    if (receiptCompanyEl) receiptCompanyEl.innerText = state.companyName.toUpperCase();
});

function updateDateDisplay() {
    const now = new Date();
    const dateEl = document.getElementById('current-date');
    if (dateEl) dateEl.innerText = now.toLocaleDateString('es-CO');
}

// CONTROL DE LOGIN / REGISTRO
function switchAuthTab(mode) {
    state.authMode = mode;
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');
    const roleField = document.getElementById('role-selection-field');
    const strengthContainer = document.getElementById('password-strength-container');
    const authBtn = document.getElementById('auth-btn');

    document.getElementById('email-input').value = '';
    document.getElementById('password-input').value = '';

    if (mode === 'register') {
        if (tabRegister) tabRegister.className = "flex-1 py-2 text-sm font-bold rounded-lg transition-all bg-white text-emerald-800 shadow-sm";
        if (tabLogin) tabLogin.className = "flex-1 py-2 text-sm font-bold rounded-lg transition-all text-emerald-600 hover:text-emerald-900";
        if (roleField) roleField.classList.remove('hidden');
        if (strengthContainer) strengthContainer.classList.remove('hidden');
        if (authBtn) authBtn.querySelector('span').innerText = "Crear Cuenta";
        
        checkRoleVisibility();
        checkPasswordStrength('');
    } else {
        if (tabLogin) tabLogin.className = "flex-1 py-2 text-sm font-bold rounded-lg transition-all bg-white text-emerald-800 shadow-sm";
        if (tabRegister) tabRegister.className = "flex-1 py-2 text-sm font-bold rounded-lg transition-all text-emerald-600 hover:text-emerald-900";
        const companyField = document.getElementById('company-name-field');
        if (companyField) companyField.classList.add('hidden');
        if (roleField) roleField.classList.remove('hidden');
        if (strengthContainer) strengthContainer.classList.add('hidden');
        if (authBtn) authBtn.querySelector('span').innerText = "Ingresar al Sistema";
    }
}

function checkRoleVisibility() {
    const roleInput = document.getElementById('user-role-input');
    const companyField = document.getElementById('company-name-field');
    
    if (!roleInput || !companyField) return;

    if (roleInput.value === 'admin') {
        companyField.classList.remove('hidden');
    } else {
        companyField.classList.add('hidden');
    }
}

function checkPasswordStrength(password) {
    if (state.authMode !== 'register') return;

    const hasLength = password.length >= 8;
    const hasUpper = /[A-ZÁÉÍÓÚÑ]/.test(password);
    const hasNumber = /[0-9]/.test(password);

    let score = 0;
    if (hasLength) score++;
    if (hasUpper) score++;
    if (hasNumber) score++;

    const bar = document.getElementById('strength-bar');
    const label = document.getElementById('strength-label');
    if (!bar || !label) return;

    if (score <= 1) {
        bar.className = "bg-red-500 h-full w-1/3 transition-all duration-300";
        label.className = "text-red-500 font-bold";
        label.innerText = "Débil";
    } else if (score === 2) {
        bar.className = "bg-amber-500 h-full w-2/3 transition-all duration-300";
        label.className = "text-amber-600 font-bold";
        label.innerText = "Moderado";
    } else if (score === 3) {
        bar.className = "bg-emerald-500 h-full w-full transition-all duration-300";
        label.className = "text-emerald-600 font-bold";
        label.innerText = "Alto / Segura";
    }
}

function handleAuthSubmit(e) {
    e.preventDefault();
    const email = document.getElementById('email-input').value.trim();
    const password = document.getElementById('password-input').value.trim();
    const roleInput = document.getElementById('user-role-input').value;

    if (state.authMode === 'register') {
        const companyInput = document.getElementById('company-name-input').value.trim();
        
        if (roleInput === 'admin' && companyInput) {
            state.companyName = companyInput;
        }

        if (password.length < 8 || !/[A-ZÁÉÍÓÚÑ]/.test(password) || !/[0-9]/.test(password)) {
            alert('La contraseña debe cumplir con los requisitos mínimos de seguridad.');
            return;
        }

        const existingUser = state.registeredUsers.find(u => u.email === email);
        if (existingUser) {
            alert('Este correo ya está registrado.');
            return;
        }

        state.registeredUsers.push({ email, password, role: roleInput });
        saveData();
        alert('¡Cuenta creada con éxito! Ahora ingresa con tus credenciales.');
        switchAuthTab('login');
        return;
    }

    let foundUser = state.registeredUsers.find(u => u.email === email && u.password === password);
    if (!foundUser && state.registeredUsers.length === 0) {
        foundUser = { email, password, role: roleInput };
        state.registeredUsers.push(foundUser);
        saveData();
    }

    if (!foundUser) {
        alert('Correo o contraseña incorrectos.');
        return;
    }

    state.currentUserRole = foundUser.role;
    state.currentUserEmail = foundUser.email;

    document.getElementById('app-company-name').innerText = state.companyName;
    document.getElementById('receipt-company').innerText = state.companyName.toUpperCase();

    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');

    applyUserRoleInterface();

    renderClientSelect();
    renderProductsPOS();
    renderInventoryTable();
    renderProductionHistory();
    renderSalesHistory();
    renderExpensesTable();
    renderMilkProvidersSelect();
    renderProvidersTable();
    renderDailyMilkTable();
    renderMonthlyBalance();
    if (window.lucide) lucide.createIcons();
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
        if (tabProv) tabProv.classList.add('hidden');
    } else {
        if (navModules) navModules.classList.remove('hidden');
        if (headerRoleBadge) headerRoleBadge.innerText = 'Panel de Administración (Dueño)';
        if (configBtnTop) configBtnTop.classList.remove('hidden');

        const tabProv = document.getElementById('milk-tab-proveedores');
        if (tabProv) tabProv.classList.remove('hidden');
        switchModule('ventas');
    }
}

function logout() {
    state.currentUserRole = 'admin';
    state.currentUserEmail = null;
    document.getElementById('main-app').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
}

// CLIENTES
function toggleNewClientForm() {
    document.getElementById('new-client-form').classList.toggle('hidden');
}

function saveClient() {
    const name = document.getElementById('new-client-name').value.trim();
    const phone = document.getElementById('new-client-phone').value.trim();
    if (!name) return alert('Ingresa el nombre del comprador.');

    state.clients.push({ id: Date.now(), name, phone });
    saveData();
    renderClientSelect();

    document.getElementById('client-select').value = state.clients[state.clients.length - 1].id;
    document.getElementById('new-client-name').value = '';
    document.getElementById('new-client-phone').value = '';
    toggleNewClientForm();
}

function renderClientSelect() {
    const select = document.getElementById('client-select');
    if (!select) return;
    select.innerHTML = '<option value="">-- Selecciona un comprador registrado --</option>';
    state.clients.forEach(c => {
        select.innerHTML += `<option value="${c.id}">${c.name} ${c.phone ? '(' + c.phone + ')' : ''}</option>`;
    });
}

// GASTOS
function addExpense(e) {
    e.preventDefault();
    const date = document.getElementById('exp-date-entry').value;
    const name = document.getElementById('exp-name-entry').value.trim();
    const amount = parseFloat(document.getElementById('exp-amount-entry').value) || 0;

    if (!date || !name || amount <= 0) return alert('Completa todos los datos.');

    state.expenses.unshift({ id: Date.now(), date, name, amount });
    saveData();

    document.getElementById('expense-form').reset();
    document.getElementById('exp-date-entry').valueAsDate = new Date();
    renderExpensesTable();
    renderSalesHistory();
    renderMonthlyBalance();
    alert(`Gasto "${name}" registrado.`);
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
                <td class="py-3 px-4 font-bold text-slate-800">${exp.name}</td>
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

// MÓDULO 4: ACOPIO DE LECHE
function switchMilkTab(tabName) {
    const secReg = document.getElementById('milk-section-registro');
    const secProv = document.getElementById('milk-section-proveedores');
    const btnReg = document.getElementById('milk-tab-registro');
    const btnProv = document.getElementById('milk-tab-proveedores');

    if (tabName === 'registro') {
        if (secReg) secReg.classList.remove('hidden');
        if (secProv) secProv.classList.add('hidden');
        if (btnReg) btnReg.className = "px-4 py-2 bg-sky-600 text-white font-bold text-sm rounded-xl shadow-sm transition-all";
        if (btnProv) btnProv.className = "px-4 py-2 bg-slate-100 text-slate-700 font-bold text-sm rounded-xl hover:bg-slate-200 transition-all";
    } else {
        if (state.currentUserRole === 'conductor') return;
        if (secReg) secReg.classList.add('hidden');
        if (secProv) secProv.classList.remove('hidden');
        if (btnProv) btnProv.className = "px-4 py-2 bg-sky-600 text-white font-bold text-sm rounded-xl shadow-sm transition-all";
        if (btnReg) btnReg.className = "px-4 py-2 bg-slate-100 text-slate-700 font-bold text-sm rounded-xl hover:bg-slate-200 transition-all";
    }
}

function addMilkProvider(e) {
    e.preventDefault();
    if (state.currentUserRole === 'conductor') return alert('No autorizado.');
    const name = document.getElementById('prov-name').value.trim();
    const pricePerLiter = parseFloat(document.getElementById('prov-price').value) || 0;

    if (!name || pricePerLiter <= 0) return alert('Ingresa nombre y precio.');

    state.milkProviders.push({ id: Date.now(), name, pricePerLiter });
    saveData();
    document.getElementById('provider-form').reset();
    renderMilkProvidersSelect();
    renderProvidersTable();
    alert(`Proveedor "${name}" creado.`);
}

function renderMilkProvidersSelect() {
    const select = document.getElementById('daily-milk-provider-select');
    if (!select) return;
    select.innerHTML = '<option value="">-- Elige un proveedor --</option>';
    state.milkProviders.forEach(p => {
        select.innerHTML += `<option value="${p.id}">${p.name}</option>`;
    });
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
            if (log.providerId === prov.id) totalLiters += log.liters;
        });

        const totalToPay = totalLiters * prov.pricePerLiter;
        tbody.innerHTML += `
            <tr class="border-b border-sky-50 hover:bg-sky-50/40">
                <td class="py-3 px-4 font-bold text-slate-800">${prov.name}</td>
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
        if (log.providerId === prov.id) totalLiters += log.liters;
    });

    const totalToPay = totalLiters * prov.pricePerLiter;
    if (totalToPay <= 0) return alert(`El proveedor ${prov.name} tiene $0 por pagar.`);

    if (!confirm(`¿Pagar quincena a ${prov.name} por $${totalToPay.toLocaleString('es-CO')} (${totalLiters} L)?`)) return;

    state.expenses.unshift({
        id: Date.now(),
        date: new Date().toISOString().split('T')[0],
        name: `Pago Quincena Leche: ${prov.name} (${totalLiters} L)`,
        amount: totalToPay
    });

    state.dailyMilkLogs = state.dailyMilkLogs.filter(log => log.providerId !== prov.id);
    saveData();
    renderProvidersTable();
    renderDailyMilkTable();
    renderExpensesTable();
    renderSalesHistory();
    renderMonthlyBalance();
    alert(`¡Pago registrado a ${prov.name}!`);
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
    if (confirm("¿Eliminar proveedor?")) {
        state.milkProviders = state.milkProviders.filter(p => p.id !== id);
        state.dailyMilkLogs = state.dailyMilkLogs.filter(l => l.providerId !== id);
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

    if (!date || !providerId || liters <= 0) return alert('Selecciona proveedor y cantidad.');

    const provider = state.milkProviders.find(p => p.id === providerId);
    if (!provider) return alert('Proveedor no encontrado.');

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
    alert(`¡Registrados ${liters} L de ${provider.name}!`);
}

function renderDailyMilkTable() {
    const tbody = document.getElementById('daily-milk-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    const todayStr = new Date().toISOString().split('T')[0];
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
                    <td class="py-3 px-4 font-bold text-slate-800">${log.providerName} <span class="text-[10px] text-slate-400">(${log.registeredBy})</span></td>
                    <td class="py-3 px-4 font-mono text-sky-800 font-bold">${log.liters} Litros</td>
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
    if (state.currentUserRole === 'conductor') return alert('No autorizado.');
    if (confirm("¿Reiniciar quincena? Se limpiará el acumulado.")) {
        state.dailyMilkLogs = [];
        saveData();
        renderDailyMilkTable();
        renderProvidersTable();
        alert("¡Quincena reiniciada!");
    }
}

// PRODUCCIÓN Y POS
function handleSaleTypeChange() {
    const saleType = document.getElementById('prod-sale-type').value;
    const groupBlocks = document.getElementById('group-blocks');
    const groupUnits = document.getElementById('group-units');
    const labelPrice = document.getElementById('label-price-unit');

    if (saleType === 'kilos') {
        if (groupBlocks) groupBlocks.classList.remove('hidden');
        if (groupUnits) groupUnits.classList.add('hidden');
        if (labelPrice) labelPrice.innerText = 'Precio por Kilo ($)';
    } else {
        if (groupBlocks) groupBlocks.classList.add('hidden');
        if (groupUnits) groupUnits.classList.remove('hidden');
        if (labelPrice) labelPrice.innerText = 'Precio por Unidad ($)';
    }
}

function addDailyProduction(e) {
    e.preventDefault();
    const productName = document.getElementById('prod-name-entry').value.trim();
    const saleType = document.getElementById('prod-sale-type').value;
    const price = parseFloat(document.getElementById('prod-price-entry').value) || 0;
    const date = document.getElementById('prod-date-entry').value;

    if (!productName || price <= 0 || !date) return alert('Completa todos los campos.');

    let product = state.products.find(p => p.name.toLowerCase() === productName.toLowerCase());

    if (saleType === 'kilos') {
        const blocks = parseFloat(document.getElementById('prod-blocks-entry').value) || 0;
        const kilos = parseFloat(document.getElementById('prod-kilos-entry').value) || 0;
        if (kilos <= 0) return alert('Ingresa los kilos.');

        if (product) {
            product.blocks += blocks;
            product.kilos += kilos;
            product.pricePerKg = price;
        } else {
            product = { id: Date.now(), name: productName, saleType: 'kilos', blocks, kilos, pricePerKg: price, stockUnits: 0, pricePerUnit: 0 };
            state.products.push(product);
        }
        state.productionLogs.unshift({ id: Date.now(), productName, detail: `+${blocks} blq / +${kilos} kg`, date });
    } else {
        const stockUnits = parseFloat(document.getElementById('prod-units-entry').value) || 0;
        if (stockUnits <= 0) return alert('Ingresa unidades.');

        if (product) {
            product.stockUnits += stockUnits;
            product.pricePerUnit = price;
        } else {
            product = { id: Date.now(), name: productName, saleType: 'unidad', blocks: 0, kilos: 0, pricePerKg: 0, stockUnits, pricePerUnit: price };
            state.products.push(product);
        }
        state.productionLogs.unshift({ id: Date.now(), productName, detail: `+${stockUnits} unidades`, date });
    }

    saveData();
    document.getElementById('production-form').reset();
    document.getElementById('prod-date-entry').valueAsDate = new Date();
    handleSaleTypeChange();
    renderInventoryTable();
    renderProductsPOS();
    renderProductionHistory();
    alert(`¡Producto "${productName}" registrado!`);
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
        let stockText = p.saleType === 'kilos' ? `${p.blocks} blq (${p.kilos} kg)` : `${p.stockUnits} unidades`;
        let priceText = p.saleType === 'kilos' ? `$${p.pricePerKg.toLocaleString('es-CO')} / kg` : `$${p.pricePerUnit.toLocaleString('es-CO')} / und`;

        tbody.innerHTML += `
            <tr class="border-b border-emerald-50">
                <td class="py-3 px-4 font-bold text-slate-800">${p.name}</td>
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
    const np = prompt(`Nuevo precio para ${p.name}:`, cur);
    if (np !== null && !isNaN(np)) {
        if (p.saleType === 'kilos') p.pricePerKg = parseFloat(np);
        else p.pricePerUnit = parseFloat(np);
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
        container.innerHTML += `<div class="flex justify-between items-center bg-emerald-50/60 p-2.5 rounded-xl text-xs border border-emerald-100"><div><p class="font-bold text-emerald-950">${log.productName}</p><p class="text-[10px] text-slate-500">${log.date}</p></div><span class="font-mono font-bold text-emerald-700 bg-white px-2 py-1 rounded-lg">${log.detail}</span></div>`;
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

    state.products.forEach(p => {
        let isAvailable = p.saleType === 'kilos' ? p.kilos > 0 : p.stockUnits > 0;
        let stockBadge = p.saleType === 'kilos' ? `Stock: ${p.kilos} kg` : `Stock: ${p.stockUnits} und`;
        let priceText = p.saleType === 'kilos' ? `$${p.pricePerKg.toLocaleString('es-CO')} / kg` : `$${p.pricePerUnit.toLocaleString('es-CO')} / und`;

        grid.innerHTML += `
            <div class="bg-white border border-emerald-100 rounded-xl p-4 flex flex-col justify-between shadow-sm">
                <div>
                    <span class="text-[10px] font-bold ${isAvailable ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'} px-2 py-0.5 rounded-full uppercase">${stockBadge}</span>
                    <h4 class="font-bold text-slate-800 mt-2 text-sm">${p.name}</h4>
                    <p class="text-base font-black text-emerald-700 mt-1">${priceText}</p>
                </div>
                <button onclick="promptSellProduct(${p.id})" ${!isAvailable ? 'disabled' : ''} class="mt-3 w-full ${isAvailable ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-slate-200 text-slate-400 cursor-not-allowed'} font-bold py-2 rounded-lg text-xs">
                    ${isAvailable ? 'Vender' : 'Sin Stock'}
                </button>
            </div>`;
    });
    if (window.lucide) lucide.createIcons();
}

function promptSellProduct(productId) {
    const product = state.products.find(p => p.id === productId);
    if (!product) return;

    if (product.saleType === 'kilos') {
        const inputKilos = prompt(`¿Cuántos kilos de "${product.name}" vas a vender? (Stock: ${product.kilos} kg):`, "1");
        if (inputKilos === null) return;
        const kilosToSell = parseFloat(inputKilos);
        if (isNaN(kilosToSell) || kilosToSell <= 0 || kilosToSell > product.kilos) return alert('Cantidad inválida.');

        const inputBlocks = prompt(`¿Cuántos bloques físicos equivalentes se entregan?:`, "1");
        const blocksToSell = inputBlocks !== null ? parseFloat(inputBlocks) || 0 : 0;

        state.cart.push({ id: product.id, name: product.name, saleType: 'kilos', price: product.pricePerKg, kilos: kilosToSell, blocksEquivalent: blocksToSell, units: 0 });
    } else {
        const inputUnits = prompt(`¿Cuántas unidades de "${product.name}" vas a vender? (Stock: ${product.stockUnits}):`, "1");
        if (inputUnits === null) return;
        const unitsToSell = parseFloat(inputUnits);
        if (isNaN(unitsToSell) || unitsToSell <= 0 || unitsToSell > product.stockUnits) return alert('Cantidad inválida.');

        state.cart.push({ id: product.id, name: product.name, saleType: 'unidad', price: product.pricePerUnit, kilos: 0, blocksEquivalent: 0, units: unitsToSell });
    }
    renderCart();
}

function renderCart() {
    const cartContainer = document.getElementById('cart-items');
    if (!cartContainer) return;

    if (state.cart.length === 0) {
        cartContainer.innerHTML = '<p class="text-emerald-400/60 text-center text-sm py-8">No has agregado productos.</p>';
        document.getElementById('cart-total').innerText = '$0';
        calculateChange();
        return;
    }

    cartContainer.innerHTML = '';
    let total = 0;
    state.cart.forEach(item => {
        let itemTotal = item.saleType === 'kilos' ? (item.price * item.kilos) : (item.price * item.units);
        total += itemTotal;
        cartContainer.innerHTML += `<div class="flex items-center justify-between bg-emerald-900/60 p-2.5 rounded-xl text-xs border border-emerald-800 text-white"><div><p class="font-bold">${item.name}</p><p class="text-emerald-300">${item.saleType === 'kilos' ? item.kilos + 'kg' : item.units + 'und'}</p></div><span class="font-bold font-mono">$${itemTotal.toLocaleString('es-CO')}</span></div>`;
    });

    document.getElementById('cart-total').innerText = `$${total.toLocaleString('es-CO')}`;
    calculateChange();
}

function calculateChange() {
    const total = state.cart.reduce((acc, i) => acc + (i.saleType === 'kilos' ? (i.price * i.kilos) : (i.price * i.units)), 0);
    const received = parseFloat(document.getElementById('received-amount').value) || 0;
    const change = received - total;
    const changeEl = document.getElementById('change-amount');
    if (!changeEl) return;
    changeEl.innerText = change >= 0 ? `$${change.toLocaleString('es-CO')}` : `Falta $${Math.abs(change).toLocaleString('es-CO')}`;
}

function processSaleAndPrint() {
    const clientId = document.getElementById('client-select').value;
    if (!clientId) return alert('Selecciona un comprador.');
    if (state.cart.length === 0) return alert('El carrito está vacío.');

    const client = state.clients.find(c => c.id == clientId);
    const paymentMethod = document.getElementById('payment-method').value;
    const total = state.cart.reduce((acc, i) => acc + (i.saleType === 'kilos' ? (i.price * i.kilos) : (i.price * i.units)), 0);
    const received = parseFloat(document.getElementById('received-amount').value) || 0;

    state.cart.forEach(item => {
        const product = state.products.find(p => p.id === item.id);
        if (product) {
            if (product.saleType === 'kilos') {
                product.kilos = Math.max(0, parseFloat((product.kilos - item.kilos).toFixed(2)));
                product.blocks = Math.max(0, parseFloat((product.blocks - item.blocksEquivalent).toFixed(2)));
            } else {
                product.stockUnits = Math.max(0, product.stockUnits - item.units);
            }
        }
    });

    state.salesHistory.unshift({
        id: Date.now(),
        date: new Date().toLocaleString('es-CO'),
        rawDate: new Date().toISOString().split('T')[0],
        clientName: client.name,
        paymentMethod,
        items: [...state.cart],
        total
    });

    saveData();

    document.getElementById('receipt-company').innerText = state.companyName.toUpperCase();
    document.getElementById('receipt-date').innerText = new Date().toLocaleString('es-CO');
    document.getElementById('receipt-client').innerText = client.name;
    document.getElementById('receipt-payment-method').innerText = paymentMethod;

    const tbody = document.getElementById('receipt-items-body');
    tbody.innerHTML = '';
    state.cart.forEach(item => {
        tbody.innerHTML += `<tr><td>${item.name}</td><td class="text-right font-bold">$${(item.saleType === 'kilos' ? item.price * item.kilos : item.price * item.units).toLocaleString('es-CO')}</td></tr>`;
    });

    document.getElementById('receipt-total').innerText = `$${total.toLocaleString('es-CO')}`;
    document.getElementById('receipt-received').innerText = `$${received.toLocaleString('es-CO')}`;
    document.getElementById('receipt-change').innerText = `$${Math.max(0, received - total).toLocaleString('es-CO')}`;

    document.getElementById('modal-receipt').classList.remove('hidden');
    document.getElementById('modal-receipt').classList.add('flex');

    renderProductsPOS();
    renderInventoryTable();
    renderSalesHistory();
    renderMonthlyBalance();
    state.cart = [];
    document.getElementById('received-amount').value = '';
    renderCart();
}

function renderSalesHistory() {
    const tbody = document.getElementById('sales-history-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    const todayStr = new Date().toISOString().split('T')[0];
    let totalVendidoHoy = 0, totalNequiHoy = 0, totalEfectivoHoy = 0, totalGastosHoy = 0;

    state.salesHistory.forEach(sale => {
        if ((sale.rawDate || sale.date) === todayStr) {
            totalVendidoHoy += sale.total;
            if (sale.paymentMethod === 'Nequi') totalNequiHoy += sale.total;
            else if (sale.paymentMethod === 'Efectivo') totalEfectivoHoy += sale.total;
        }
    });

    state.expenses.forEach(exp => {
        if (exp.date === todayStr) totalGastosHoy += exp.amount;
    });

    const efectivoRealEnCaja = Math.max(0, totalEfectivoHoy - totalGastosHoy);

    if (state.salesHistory.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center py-6 text-slate-400 font-medium">No hay ventas.</td></tr>';
    } else {
        state.salesHistory.forEach(sale => {
            const itemsDesc = sale.items.map(i => i.saleType === 'kilos' ? `${i.kilos}kg ${i.name}` : `${i.units}und ${i.name}`).join(', ');
            tbody.innerHTML += `
                <tr class="border-b border-emerald-50">
                    <td class="py-3 px-4 font-mono text-xs text-slate-500">${sale.date}</td>
                    <td class="py-3 px-4 font-bold text-slate-800">${sale.clientName}</td>
                    <td class="py-3 px-4 text-slate-600 text-xs">${itemsDesc}</td>
                    <td class="py-3 px-4"><span class="px-2 py-1 rounded-full text-xs font-bold ${sale.paymentMethod === 'Efectivo' ? 'bg-emerald-100 text-emerald-800' : 'bg-sky-100 text-sky-800'}">${sale.paymentMethod}</span></td>
                    <td class="py-3 px-4 text-right font-mono font-black text-emerald-700">$${sale.total.toLocaleString('es-CO')}</td>
                </tr>`;
        });
    }

    const statTotalHoy = document.getElementById('stat-total-hoy');
    const statTotalNequi = document.getElementById('stat-total-nequi');
    const statTotalGastos = document.getElementById('stat-total-gastos');
    const statEfectivoCaja = document.getElementById('stat-efectivo-caja');

    if (statTotalHoy) statTotalHoy.innerText = `$${totalVendidoHoy.toLocaleString('es-CO')}`;
    if (statTotalNequi) statTotalNequi.innerText = `$${totalNequiHoy.toLocaleString('es-CO')}`;
    if (statTotalGastos) statTotalGastos.innerText = `-$${totalGastosHoy.toLocaleString('es-CO')}`;
    if (statEfectivoCaja) statEfectivoCaja.innerText = `$${efectivoRealEnCaja.toLocaleString('es-CO')}`;
}

function renderMonthlyBalance() {
    let totalVentasMes = 0, totalNequiMes = 0, totalGastosMes = 0;
    state.salesHistory.forEach(s => {
        totalVentasMes += s.total;
        if (s.paymentMethod === 'Nequi') totalNequiMes += s.total;
    });
    state.expenses.forEach(e => totalGastosMes += e.amount);

    const mTotalSales = document.getElementById('monthly-total-sales');
    const mTotalNequi = document.getElementById('monthly-total-nequi');
    const mTotalExpenses = document.getElementById('monthly-total-expenses');
    const mNetProfit = document.getElementById('monthly-net-profit');

    if (mTotalSales) mTotalSales.innerText = `$${totalVentasMes.toLocaleString('es-CO')}`;
    if (mTotalNequi) mTotalNequi.innerText = `$${totalNequiMes.toLocaleString('es-CO')}`;
    if (mTotalExpenses) mTotalExpenses.innerText = `-$${totalGastosMes.toLocaleString('es-CO')}`;
    if (mNetProfit) mNetProfit.innerText = `$${(totalVentasMes - totalGastosMes).toLocaleString('es-CO')}`;
}

function clearSalesHistory() {
    if (confirm("¿Borrar historial de ventas?")) {
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

function triggerPrint() { window.print(); }

function openConfigModal() {
    document.getElementById('modal-company-name-input').value = state.companyName;
    document.getElementById('modal-config').classList.remove('hidden');
    document.getElementById('modal-config').classList.add('flex');
}

function closeConfigModal() {
    document.getElementById('modal-config').classList.add('hidden');
    document.getElementById('modal-config').classList.remove('flex');
}

function saveCompanyName() {
    const newName = document.getElementById('modal-company-name-input').value.trim();
    if (newName) {
        state.companyName = newName;
        saveData();
        document.getElementById('app-company-name').innerText = newName;
        document.getElementById('display-company-title').innerText = newName;
        document.getElementById('receipt-company').innerText = newName.toUpperCase();
    }
    closeConfigModal();
}

function switchModule(modName) {
    if (state.currentUserRole === 'conductor') {
        modName = 'leche';
    }

    const views = ['ventas', 'historial', 'gastos', 'inventario', 'leche', 'vehiculos', 'contabilidad'];
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

    if (modName === 'leche') {
        const dateInput = document.getElementById('daily-milk-date');
        if (dateInput && !dateInput.value) dateInput.valueAsDate = new Date();
        renderMilkProvidersSelect();
        renderProvidersTable();
        renderDailyMilkTable();
        
        if (state.currentUserRole === 'conductor') {
            const tabsContainer = document.getElementById('milk-tabs-container');
            if (tabsContainer) tabsContainer.classList.add('hidden');
            const secProv = document.getElementById('milk-section-proveedores');
            if (secProv) secProv.classList.add('hidden');
            const secReg = document.getElementById('milk-section-registro');
            if (secReg) secReg.classList.remove('hidden');
        }
    }
}

// EXPORTAR FUNCIONES AL ÁMBITO GLOBAL
window.switchAuthTab = switchAuthTab;
window.handleAuthSubmit = handleAuthSubmit;
window.checkRoleVisibility = checkRoleVisibility;
window.checkPasswordStrength = checkPasswordStrength;
window.switchModule = switchModule;
window.toggleNewClientForm = toggleNewClientForm;
window.saveClient = saveClient;
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
window.processSaleAndPrint = processSaleAndPrint;
window.clearSalesHistory = clearSalesHistory;
window.closeReceiptModal = closeReceiptModal;
window.triggerPrint = triggerPrint;
window.openConfigModal = openConfigModal;
window.closeConfigModal = closeConfigModal;
window.saveCompanyName = saveCompanyName;
window.logout = logout;