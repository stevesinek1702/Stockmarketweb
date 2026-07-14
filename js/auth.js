/**
 * Auth helper (Phase 3) — dùng cho login.html, register.html, admin.html
 * và index.html gating.
 *
 * Cookie httpOnly: browser tự gửi cookie với mọi same-origin request,
 * nên KHÔNG cần đính header Authorization thủ công trong api.js.
 *
 * Cache user info trong localStorage để tránh gọi /me nhiều lần.
 */
(function () {
    const USER_KEY = 'vnstock_auth_user';

    /**
     * Gọi /api/auth/me để verify session hiện tại.
     * @returns {Promise<object|null>} user object hoặc null nếu chưa login
     */
    async function currentUser() {
        try {
            const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
            if (!res.ok) return null;
            const json = await res.json();
            return json.success ? json.user : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Login (set cookie server-side).
     */
    async function login(username, password) {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ username, password })
        });
        const json = await res.json();
        if (!json.success) {
            const err = new Error(json.error || 'Đăng nhập thất bại');
            err.status = res.status;
            err.code = res.status;
            throw err;
        }
        localStorage.setItem(USER_KEY, JSON.stringify(json.user));
        return json.user;
    }

    /**
     * Register (status=pending, chờ admin duyệt).
     */
    async function register(username, password, email) {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ username, password, email })
        });
        const json = await res.json();
        if (!json.success) {
            const err = new Error(json.error || 'Đăng ký thất bại');
            err.status = res.status;
            throw err;
        }
        return json;
    }

    /**
     * Logout (clear cookie server-side + localStorage).
     */
    async function logout() {
        await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'same-origin'
        }).catch(() => {});
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem('vnstock_auth_user_role');
    }

    /**
     * Cache user role để index.html gating nhanh (không chờ network).
     */
    function getCachedUser() {
        try {
            return JSON.parse(localStorage.getItem(USER_KEY));
        } catch (e) {
            return null;
        }
    }

    /**
     * Bắt全局 401: redirect về login.
     * Gọi 1 lần ở index.html sau khi app init.
     */
    function intercept401() {
        const origFetch = window.fetch;
        window.fetch = function (...args) {
            return origFetch.apply(this, args).then(res => {
                if (res.status === 401) {
                    logout().finally(() => {
                        window.location.href = '/login.html';
                    });
                }
                return res;
            });
        };
    }

    window.VNAuth = {
        currentUser,
        login,
        register,
        logout,
        getCachedUser,
        intercept401
    };
})();
