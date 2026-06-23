// Test Round 3 fixes: fuzzy name matching, project listing, person-project, re-test previous fixes
const BASE = 'http://localhost:3000';

async function testChat(msg, expected) {
  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, context: {}, history: [] })
    });
    const data = await res.json();
    const reply = (data.reply || data.message || '').substring(0, 300);
    const pass = expected ? expected(reply) : true;
    console.log(`${pass ? '✅' : '❌'} "${msg}"`);
    console.log(`   → ${reply}`);
    if (!pass) console.log(`   ⚠️  FAILED expectation`);
    console.log('');
    return pass;
  } catch (e) {
    console.log(`❌ "${msg}" → ERROR: ${e.message}\n`);
    return false;
  }
}

async function run() {
  console.log('=== ROUND 3 TESTS ===\n');
  
  // 1. Fuzzy name matching - "Huy" should find "Huy Đỗ"
  await testChat('Huy có task gì tháng này', r => r.toLowerCase().includes('huy'));
  
  // 2. Full name variant
  await testChat('Đỗ Quốc Huy check xem', r => r.toLowerCase().includes('huy'));
  
  // 3. Project listing - should return real project data
  await testChat('Những dự án đang chạy', r => !r.includes('không có dữ liệu') && r.length > 20);
  
  // 4. Person-project cross reference
  await testChat('Huy làm ở những dự án nào', r => r.toLowerCase().includes('huy'));
  
  // 5. Re-test: total points
  await testChat('Tổng điểm thực tế tháng này', r => r.length > 20);
  
  // 6. Re-test: most productive member
  await testChat('Thành viên nào năng suất nhất?', r => r.length > 20);
  
  // 7. Re-test: workload comparison
  await testChat('So sánh workload giữa các dự án', r => r.length > 20);
  
  // 8. Casual chat (should still work)
  await testChat('hello', r => r.length > 5);
  
  console.log('=== DONE ===');
}

run();
