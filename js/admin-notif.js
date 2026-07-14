/**
 * Admin notification bell (Phase 3+) — chuông 🔔 ở header dashboard.
 * Chỉ admin thấy. Polling mỗi 30s đếm user pending. Bấm chuông → dropdown
 * list user pending + nút Duyệt ngay (không cần vào /admin.html).
 *
 * Yêu cầu: VNAuth đã load, user.role === 'admin'.
 */
(function () {
    let pollTimer = null;
    const POLL_INTERVAL = 30000; // 30s

    async function fetchPending() {
        try {
            const res = await fetch('/api/admin/users?status=pending', { credentials: 'same-origin' });
            if (!res.ok) return [];
            const j = await res.json();
            return j.success ? j.users : [];
        } catch (e) {
            return [];
        }
    }

    function updateBadge(count) {
        const badge = document.getElementById('notifBadge');
        if (!badge) return;
        if (count > 0) {
            badge.textContent = count > 99 ? '99+' : count;
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    }

    function fmtRelative(iso) {
        const diff = Date.now() - new Date(iso).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'vừa xong';
        if (mins < 60) return mins + ' phút trước';
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return hrs + ' giờ trước';
        return Math.floor(hrs / 24) + ' ngày trước';
    }

    async function renderList() {
        const list = document.getElementById('notifList');
        if (!list) return;
        list.innerHTML = '<div style="text-align:center;color:var(--text-muted);font-size:0.8rem;padding:16px 0;">Đang tải...</div>';
        const users = await fetchPending();
        updateBadge(users.length);

        if (!users.length) {
            list.innerHTML = '<div style="text-align:center;color:var(--text-muted);font-size:0.8rem;padding:20px 0;">✅ Không có yêu cầu nào chờ duyệt</div>';
            return;
        }
        list.innerHTML = users.map(u => `
            <div class="notif-item">
                <div class="ni-info">
                    <div class="ni-name">${u.username}</div>
                    <div class="ni-meta">${u.email || 'không email'} · ${fmtRelative(u.created_at)}</div>
                </div>
                <button class="btn-sm btn-approve" onclick="adminNotif.approve(${u.id}, '${u.username}')">✓ Duyệt</button>
                <button class="btn-sm btn-delete" onclick="adminNotif.reject(${u.id}, '${u.username}')">✕</button>
            </div>
        `).join('');
    }

    async function approve(id, username) {
        try {
            const res = await fetch(`/api/admin/users/${id}`, {
                method: 'PATCH', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'active' })
            });
            const j = await res.json();
            if (!j.success) throw new Error(j.error);
            console.log(`✅ Đã duyệt ${username}`);
            await refreshBadge();
            // Nếu panel đang mở → re-render
            if (document.getElementById('notifPanel').style.display !== 'none') {
                renderList();
            }
        } catch (e) {
            console.error('Approve failed:', e.message);
        }
    }

    async function reject(id, username) {
        if (!confirm(`Từ chối & xóa yêu cầu của "${username}"?`)) return;
        try {
            const res = await fetch(`/api/admin/users/${id}`, {
                method: 'DELETE', credentials: 'same-origin'
            });
            const j = await res.json();
            if (!j.success) throw new Error(j.error);
            console.log(`🗑️ Đã xóa ${username}`);
            await refreshBadge();
            if (document.getElementById('notifPanel').style.display !== 'none') {
                renderList();
            }
        } catch (e) {
            console.error('Reject failed:', e.message);
        }
    }

    async function refreshBadge() {
        const users = await fetchPending();
        updateBadge(users.length);
    }

    function togglePanel() {
        const panel = document.getElementById('notifPanel');
        const isOpen = panel.style.display !== 'none';
        if (isOpen) {
            panel.style.display = 'none';
        } else {
            panel.style.display = 'block';
            renderList();
        }
    }

    /**
     * Khởi tạo chuông — gọi sau khi auth gating xác nhận role=admin.
     */
    function init() {
        const bell = document.getElementById('notifBell');
        if (!bell) return;
        bell.style.display = 'inline-block';

        const btn = document.getElementById('notifBtn');
        const panel = document.getElementById('notifPanel');
        const closeBtn = document.getElementById('notifClose');
        if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); togglePanel(); });
        if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); panel.style.display = 'none'; });

        // Đóng panel khi click ra ngoài
        document.addEventListener('click', (e) => {
            if (!bell.contains(e.target)) panel.style.display = 'none';
        });

        // Poll ban đầu + định kỳ
        refreshBadge();
        pollTimer = setInterval(refreshBadge, POLL_INTERVAL);
    }

    window.adminNotif = { init, approve, reject, refreshBadge, renderList };
})();
