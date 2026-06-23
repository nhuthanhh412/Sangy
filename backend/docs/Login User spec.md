# Đặc tả Kỹ thuật - Hệ thống Xác thực & Phân quyền (Login User Spec)

## 0. Ràng buộc Hệ thống (System Constraints)
-   **Không có Auto Sign-up**: Chỉ email đã tồn tại trong bảng `users` (do Admin tạo trước) mới được phép đăng nhập.
-   **Binding Google ID**: Lần đăng nhập đầu tiên sẽ bind `google_id` vào user record có sẵn.
-   **Centralized Policy**: Tất cả logic phân quyền phải thông qua `accessPolicy.canAccess()`.
-   **Backend Filtering**: Frontend không được nhận dữ liệu vượt quá quyền hạn của user.
-   **Domain Check**: Chỉ chấp nhận email có đuôi `@company.com`.

## 1. Database Specification (SQLite)
File: `backend/data/auth.db`

### Tables
```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,          -- Email công ty (gán sẵn)
    google_id TEXT UNIQUE,               -- Update sau khi login lần đầu
    full_name TEXT,
    avatar_url TEXT,
    role TEXT CHECK(role IN ('admin','manager','member')) NOT NULL DEFAULT 'member',
    notion_user_id TEXT NOT NULL,        -- GÁN CỨNG (Không được null)
    notion_workspace_id TEXT,            -- Validate workspace context
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
);

CREATE TABLE project_managers (
    user_id INTEGER NOT NULL,
    project_id TEXT NOT NULL,            -- ID Concept/Project từ Notion
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, project_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

## 2. Authentication Flow (Passport Google)
**Environment Variables**:
-   `GOOGLE_CLIENT_ID`
-   `GOOGLE_CLIENT_SECRET`
-   `SESSION_SECRET`
-   `BASE_URL` (ví dụ: http://localhost:3000)

**Logic Xử lý Callback**:
1.  **Extract Email**: `email = profile.emails[0].value.toLowerCase()`
2.  **Domain Validation**:
    -   `if (!email.endsWith("@company.com"))` -> **403 Forbidden** (Invalid domain).
3.  **User Lookup**:
    -   `SELECT * FROM users WHERE email = ?`
    -   Nếu không tìm thấy -> **403 Forbidden** (Unauthorized: Email not registered).
    -   Nếu `user.is_active === 0` -> **403 Forbidden** (Account disabled).
4.  **First Login Binding**:
    -   Nếu `user.google_id` IS NULL -> `UPDATE users SET google_id = profile.id`.
    -   Nếu `user.google_id` !== `profile.id` -> **403 Forbidden** (Google account mismatch).
5.  **Update Session**:
    -   `UPDATE users SET last_login = CURRENT_TIMESTAMP`
    -   `req.session.user = { id, email, role, notion_user_id }`

## 3. Session Configuration
```javascript
app.use(session({
   store: new SQLiteStore({ db: 'sessions.db', dir: './data' }), // connect-sqlite3
   secret: process.env.SESSION_SECRET,
   resave: false,
   saveUninitialized: false,
   cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000 // 1 tuần
   }
}));
```

## 4. Middleware Specification
File: `src/middleware/auth.middleware.js`

-   `requireAuth`:
    -   `if (!req.session.user) return 401`.
-   `requireRole(role)`:
    -   `if (req.session.user.role !== role) return 403`.

## 5. Policy Service (CRITICAL)
File: `src/security/accessPolicy.js`

```javascript
/**
 * Check if user can access a specific record
 * @param {Object} record - The data record (must contain assignee_ids array)
 * @param {Object} user - The logged-in user
 * @param {Array} managedProjects - List of project IDs managed by the user
 */
function canAccess(record, user, managedProjects = []) {
   if (!user || !user.notion_user_id) return false;

   if (user.role === "admin") return true;

   if (user.role === "manager") {
      // Access if project is managed by user
      if (managedProjects.includes(record.project_id)) return true;
      
      // Access if user is assigned to the task (in other projects)
      if (Array.isArray(record.assignee_ids) && record.assignee_ids.includes(user.notion_user_id)) return true;

      return false;
   }

   if (user.role === "member") {
      // Access only if user is assigned
      return (Array.isArray(record.assignee_ids) && record.assignee_ids.includes(user.notion_user_id));
   }

   return false;
}
```

## 6. Report Service Specification
Ví dụ: `ProductivityService`

-   **Input**: `generateReport(currentUser)`
-   **Flow**:
    1.  Load raw data.
    2.  Nếu `role === 'manager'`, load danh sách `managed_projects` từ bảng `project_managers`.
    3.  Filter data: `data.filter(record => canAccess(record, currentUser, managedProjects))`.
    4.  Return filtered data.

## 7. User Seeding Specification
File: `backend/scripts/seed_users.js`

**Input Format**:
```json
[
  {
    "email": "admin@company.com",
    "role": "admin",
    "notion_user_id": "xxx-xxx",
    "notion_workspace_id": "workspace_1"
  },
  {
    "email": "manager@company.com",
    "role": "manager",
    "notion_user_id": "yyy-yyy",
    "managed_projects": ["proj_1", "proj_2"]
  }
]
```

**Behavior**:
-   Insert user nếu chưa tồn tại (theo email).
-   Nếu user tồn tại, **không** overwrite `google_id`.
-   Insert vào bảng `project_managers` nếu role là `manager` và có `managed_projects`.

## 8. API Contract
-   **GET /api/auth/me**:
    -   Trả về: `{ id, email, role, notion_user_id, avatar_url }`
    -   Lỗi: 401 nếu chưa login.
-   **GET /api/users** (Admin only):
    -   Trả về danh sách users (không bao gồm `google_id`).

## 9. Security & Edge Cases
-   **Edge Cases**:
    -   `record.assignee_ids` là `null`/`undefined` -> Coi như mảng rỗng `[]`.
    -   `user.notion_user_id` thiếu -> Từ chối truy cập.
    -   `managedProjects` undefined -> Coi như `[]`.
-   **Guarantees**:
    -   Backend luôn lọc dữ liệu trước khi trả về.
    -   Frontend không bao giờ nhận được dữ liệu "thừa".
