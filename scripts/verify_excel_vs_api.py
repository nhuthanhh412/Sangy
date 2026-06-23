
import pandas as pd
import requests
import json
from datetime import datetime

# Configuration
EXCEL_FILE = 'ALL_PROJECTS_combined.xlsx'
API_BASE = 'http://localhost:3000'
START_DATE = '2026-01-01'
END_DATE = '2026-01-31'

def main():
    print(f"--- COMPARISON REPORT: {EXCEL_FILE} vs API ({START_DATE} to {END_DATE}) ---")

    # 1. Read Excel
    print(f"Reading Excel: {EXCEL_FILE}...")
    try:
        df = pd.read_excel(EXCEL_FILE)
        print(f"Excel loaded. Rows: {len(df)}")
        # Print column names for debug
        # print("Excel Columns:", df.columns.tolist())
    except Exception as e:
        print(f"Error reading Excel: {e}")
        return

    # Count breakdown by Project (DỰ ÁN)
    excel_project_counts = df['DỰ ÁN'].value_counts()
    print("\n--- Excel Top 10 Projects ---")
    print(excel_project_counts.head(10))
    
    # 2. Fetch API Data
    print("\nfetching API Whitelist...")
    try:
        wl_resp = requests.get(f"{API_BASE}/api/notion/project-whitelist")
        wl_data = wl_resp.json()
        
        if not wl_data.get('success'):
            print("Failed to fetch whitelist")
            return

        # Extract Task Database IDs
        task_db_ids = []
        project_names = {} # ID -> Name
        
        for proj in wl_data['data']:
            if not proj.get('databases'): continue
            for db in proj['databases']:
                if db['type'] == 'tasks' or 'Task' in db['name']:
                    task_db_ids.append(db['id'])
                    project_names[db['id']] = proj['name']
        
        print(f"Found {len(task_db_ids)} Task Databases for API call.")
        
        # Call Productivity API
        print("Fetching Productivity Report from API (this may take time)...")
        payload = {
            "startDate": START_DATE,
            "endDate": END_DATE,
            "databaseIds": task_db_ids,
            "standardDays": 22
        }
        
        report_resp = requests.post(f"{API_BASE}/api/reports/productivity", json=payload)
        report_data = report_resp.json()
        
        if not report_data.get('success'):
            print(f"API Error: {report_data.get('error')}")
            return
            
        api_tasks = report_data.get('data', []) # This might be by assignee?
        # Actually data is array of assignees.
        # We need "totalProcessed" or similar?
        stats = report_data.get('filterStats', {})
        print("\n--- API Stats ---")
        print(f"Total Processed (Raw): {stats.get('totalProcessed')}")
        print(f"Total Accepted (In Range): {stats.get('totalAccepted')}")
        print(f"Rejected (Status): {stats.get('rejectedStatus')}")
        print(f"Rejected (Date): {stats.get('rejectedDateMissing') + stats.get('rejectedDateRange')}")
        
        # Calculate Total Tasks from Assignee Grouping
        # The structure is data: [ { name, totalTasks, ... } ]
        total_api_tasks = sum(u.get('totalTasks', 0) for u in api_tasks)
        print(f"Total Tasks in Report (Sum of Assignees): {total_api_tasks}")
        
    except Exception as e:
        print(f"API Error: {e}")
        return

    # 3. Comparison
    print("\n--- FINAL VERDICT ---")
    print(f"Excel Total: {len(df)}")
    print(f"API Total:   {stats.get('totalAccepted')} (Raw Accepted) / {total_api_tasks} (Grouped)")
    
    diff = len(df) - stats.get('totalAccepted', 0)
    print(f"Difference: {diff}")
    
    if abs(diff) < 50:
        print(">> MATCHED (Close enough)")
    else:
        print(">> MISMATCH (Significant difference)")
        
    print("\nDone.")

if __name__ == "__main__":
    main()
