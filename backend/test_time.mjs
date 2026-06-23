// Test expandSynonyms + parseTimeRange together
function normalizeQuery(text = '') {
    return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function expandSynonyms(q) {
    const map = [
        [/dua nao|thang nao|con nao|nguoi nao/g, 'ai'],
        [/may dua|moi dua|tat ca moi nguoi|ca team/g, 'tung member'],
        [/nhieu nhat|so 1|number one|top 1/g, 'nhieu nhat'],
        [/it nhat|thap nhat/g, 'it nhat'],
        [/thang roi|thang vua roi|thang vua qua/g, 'thang truoc'],
        [/tuan roi|tuan vua roi|tuan vua qua/g, 'tuan truoc'],
        [/hom truoc|hom bua/g, 'hom qua'],
        [/diem|taskpoint|task point/g, 'point'],
        [/lam duoc|hoan thanh duoc|xong duoc/g, 'task'],
        [/noi chung|chung chung|tong the|tinh hinh/g, 'tong quan'],
        [/cho xem|show|hien thi/g, ''],
        [/\b(nhe|giup|nha)\b/g, ''],
        [/om nhieu viec|om viec|om nhieu|dang om/g, 'qua tai'],
        [/khong co viec|khong lam gi|ranh rang/g, 'ranh'],
        [/cay duoc|cay nhieu|cay/g, 'nhieu'],
        [/hieu suat|hieu qua/g, 'nang suat'],
        [/tang truong/g, 'cao nhat'],
        [/ton dong|con lai|chua xong|chua xuly/g, 'chua hoan thanh'],
        [/can gap|gap|khan cap/g, 'sap deadline'],
        [/no luc|noluc|nltt/g, 'effort'],
        [/ton nhieu thoi gian/g, 'effort lon'],
        [/lui lich|backlog|de lai/g, 'not started'],
        [/chua qc|xong chua qc/g, 'done chua qc'],
        [/dang chay|dang hoat dong/g, 'in progress'],
        [/chua fix|chua sua/g, 'bug chua hoan thanh'],
    ];
    let result = q;
    for (const [pattern, replacement] of map) {
        result = result.replace(pattern, replacement);
    }
    return result.replace(/\s+/g, ' ').trim();
}

function parseTimeRange(q) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let start = null, end = null, label = '';

    if (q.includes('hom nay') || q.includes('today')) {
        start = new Date(today); end = new Date(today); end.setDate(end.getDate() + 1);
        label = 'hôm nay';
    }
    else if (q.includes('hom qua') || q.includes('yesterday')) {
        start = new Date(today); start.setDate(start.getDate() - 1);
        end = new Date(today);
        label = 'hôm qua';
    }
    else if (q.includes('tuan nay') || q.includes('this week') || q.includes('trong tuan')) {
        const dow = today.getDay() || 7;
        start = new Date(today); start.setDate(start.getDate() - (dow - 1));
        end = new Date(start); end.setDate(end.getDate() + 7);
        label = 'tuần này';
    }
    else if (q.includes('tuan truoc') || q.includes('last week') || q.includes('tuan qua')) {
        const dow = today.getDay() || 7;
        start = new Date(today); start.setDate(start.getDate() - (dow - 1) - 7);
        end = new Date(start); end.setDate(end.getDate() + 7);
        label = 'tuần trước';
    }
    else if (q.includes('thang nay') || q.includes('this month') || q.includes('trong thang')) {
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        label = 'tháng này';
    }
    else if (q.includes('thang truoc') || q.includes('last month') || q.includes('thang qua')) {
        start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        end = new Date(now.getFullYear(), now.getMonth(), 1);
        label = 'tháng trước';
    }
    else if (/thang\s*(\d{1,2})\s*[\/.\-]\s*(\d{4})/.test(q)) {
        const match = q.match(/thang\s*(\d{1,2})\s*[\/.\-]\s*(\d{4})/);
        const m = parseInt(match[1], 10);
        const y = parseInt(match[2], 10);
        if (m >= 1 && m <= 12 && y >= 2020 && y <= 2099) {
            start = new Date(y, m - 1, 1);
            end = new Date(y, m, 1);
            label = `tháng ${m}/${y}`;
        }
    }
    else if (/thang\s*(\d{1,2})(?!\s*[\/.\-]\s*\d)/.test(q)) {
        const m = parseInt(q.match(/thang\s*(\d{1,2})/)[1], 10);
        if (m >= 1 && m <= 12) {
            const y = m > (now.getMonth() + 1) ? now.getFullYear() - 1 : now.getFullYear();
            start = new Date(y, m - 1, 1);
            end = new Date(y, m, 1);
            label = `tháng ${m}/${y}`;
        }
    }
    else if (/(\d+)\s*ngay\s*(gan|qua|truoc|gan day|gan nhat)/.test(q)) {
        const days = parseInt(q.match(/(\d+)\s*ngay/)[1], 10);
        start = new Date(today); start.setDate(start.getDate() - days);
        end = new Date(today); end.setDate(end.getDate() + 1);
        label = `${days} ngày qua`;
    }

    return { start, end, label };
}

// Full pipeline test
const tests = [
    'Tổng quan task tháng này',
    'Tổng quan task tháng trước',
    'Tổng quan task tháng 12/2025',
    'Tổng quan task tháng 11/2025',
    'Tổng quan task tuần này',
    'Tổng quan task tuần trước',
    'Task tháng 2',
    'Ai rảnh nhất tháng 3/2026',
    'Giúp xem task tháng này nhé',
    'Cho xem tổng quan tháng này nha',
];

let pass = 0, fail = 0;
for (const t of tests) {
    const norm = normalizeQuery(t);
    const expanded = expandSynonyms(norm);
    const range = parseTimeRange(expanded);
    const ok = range.start && range.end;
    const icon = ok ? '✅' : '❌';
    console.log(`${icon} "${t}"`);
    console.log(`   norm: "${norm}" → syn: "${expanded}" → ${range.label || 'NO MATCH'}`);
    if (ok) pass++; else fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
