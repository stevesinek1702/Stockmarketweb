import numpy as np
import pandas as pd
from pandas import json_normalize
from datetime import datetime, time, timedelta
import requests
import json
import os # Import os module for path handling

# Define the directory for data if it doesn't exist
data_dir = 'data'
if not os.path.exists(data_dir):
    os.makedirs(data_dir)

# --- Configuration for API requests ---
# Cap nhat 2026: endpoint goc wl-market.fiintrade.vn van hoat dong neu request
# mang "danh nghia" cua SSI iBoard. Da test ky: header DUY NHAT bat buoc la "origin".
# Bo het x-fiin-*, user-agent, content-type... van chay 200. (Khong dang nhap, khong token.)
# Giu them user-agent + accept cho chac (phong khi sau nay ho loc bot).
fii_new1 = {
    "origin": "https://iboard.ssi.com.vn",   # <-- BAT BUOC
    "accept": "application/json",
    "user-agent": "Mozilla/5.0",
}
# -------------------------------------

def convert_to_billions(df):
    """Converts specified value columns in a DataFrame to billions."""
    value_columns = ['foreignBuyValue', 'foreignSellValue', 'foreignNetValue',
                     'foreignNetValueAdd', 'foreignNetValue_']

    for col in value_columns:
        if col in df.columns:
            # Ensure the column is numeric before division
            df[col] = pd.to_numeric(df[col], errors='coerce') / 1e9
    return df

def get_investor(url, time_range='today'):
    """
    Fetches investor data from the given URL for a specific time range.
    Handles API responses, JSON parsing, and basic data processing.
    """
    investor_type = url.split('=')[-1]
    df_detail = pd.DataFrame()  # Initialize to empty DataFrame
    df_sum = pd.DataFrame()      # Initialize to empty DataFrame
    # Get current date for fromDate, formatted consistently
    current_date_str = datetime.now().strftime("%Y-%m-%d")

    print(f"Attempting to fetch data for {investor_type} ({time_range})...")

    try:
        response = requests.request("GET", url, headers=fii_new1, timeout=15) # Increased timeout slightly
        response.raise_for_status() # Raises HTTPError for bad responses (4xx or 5xx)

        data = json.loads(response.content)
        if 'items' in data and len(data['items']) > 0:
            data_dict = data['items'][0]

            if time_range in data_dict:
                # --- Process detailed data ---
                # Check if 'buy' key exists within the time_range data and if it's a list
                if 'buy' in data_dict[time_range] and isinstance(data_dict[time_range]['buy'], list):
                    df_detail = pd.json_normalize(data_dict, record_path=[time_range, 'buy'])
                    df_detail['timeRange'] = time_range
                    df_detail['fromDate'] = current_date_str # Add fromDate
                    
                    # Ensure 'foreignBuyValue' and 'foreignSellValue' exist before calculation
                    if 'foreignBuyValue' in df_detail.columns and 'foreignSellValue' in df_detail.columns:
                        df_detail['foreignNetValueAdd'] = df_detail['foreignBuyValue'] - df_detail['foreignSellValue']
                    else:
                        print(f"Warning: Missing 'foreignBuyValue' or 'foreignSellValue' in detail data for {investor_type} ({time_range}).")
                        df_detail['foreignNetValueAdd'] = np.nan # Assign NaN if columns are missing

                    df_detail.drop_duplicates(inplace=True)
                    df_detail['investor'] = investor_type
                    df_detail = convert_to_billions(df_detail)
                else:
                    print(f"Warning: 'buy' key not found or not a list for {time_range} in {investor_type} detailed data. Skipping detailed processing.")
                    df_detail = pd.DataFrame() # Ensure it's empty if no valid 'buy' data

                # --- Process summary data ---
                # Ensure data_dict[time_range] is a dictionary and has required keys for summary
                if isinstance(data_dict[time_range], dict):
                    # Filter relevant keys for summary to avoid errors with .iloc[:, :8]
                    # Assuming these are the 8 keys desired
                    summary_keys = [
                        'foreignBuyValue', 'foreignSellValue', 'foreignNetValue',
                        'proprietaryBuyValue', 'proprietarySellValue', 'proprietaryNetValue',
                        'localInstitutionBuyValue', 'localInstitutionSellValue'
                    ]
                    
                    # Create a dictionary with only the desired summary keys, filling missing with None
                    summary_data = {k: data_dict[time_range].get(k) for k in summary_keys}
                    df_sum = pd.json_normalize(summary_data)
                    
                    df_sum['timeRange'] = time_range
                    df_sum['fromDate'] = current_date_str # Add fromDate
                    
                    if 'foreignBuyValue' in df_sum.columns and 'foreignSellValue' in df_sum.columns:
                        df_sum['foreignNetValueAdd'] = df_sum['foreignBuyValue'] - df_sum['foreignSellValue']
                    else:
                        print(f"Warning: Missing 'foreignBuyValue' or 'foreignSellValue' in summary data for {investor_type} ({time_range}).")
                        df_sum['foreignNetValueAdd'] = np.nan

                    df_sum.drop_duplicates(inplace=True)
                    df_sum['investor'] = investor_type
                    df_sum = convert_to_billions(df_sum)
                else:
                    print(f"Warning: Summary data for {time_range} in {investor_type} is not in expected dictionary format. Skipping summary processing.")
                    df_sum = pd.DataFrame() # Ensure it's empty if format is wrong
            else:
                print(f"Warning: Time range '{time_range}' not found in data for {investor_type}.")
        else:
            print(f"Warning: No 'items' found or 'items' is empty in response for {investor_type}.")
    except requests.exceptions.HTTPError as http_err:
        print(f"HTTP error occurred for {investor_type} ({time_range}): {http_err} - {response.text[:200]}...")
    except requests.exceptions.Timeout:
        print(f"Error: Request timed out for {investor_type} ({time_range}).")
    except requests.exceptions.ConnectionError:
        print(f"Error: Connection error for {investor_type} ({time_range}). Check network/proxy.")
    except json.JSONDecodeError:
        print(f"Error: Failed to decode JSON for {investor_type} ({time_range}). Raw content: {response.text[:200]}...")
    except KeyError as ke:
        print(f"Error: Missing expected key '{ke}' in JSON data for {investor_type} ({time_range}). This might indicate a change in API response structure.")
    except Exception as e:
        print(f'An unexpected error occurred while downloading data for {investor_type} ({time_range}): {e}')

    return df_detail, df_sum

def get_investor_all(urls, time_range):
    """
    Iterates through a list of URLs to fetch investor data and combines them.
    Handles empty DataFrames from individual fetches.
    """
    total_url = len(urls)
    
    dataframes_detail = []
    dataframes_sum = []

    print(f"Fetching data for {time_range} across all investor types...")

    for index, url in enumerate(urls):
        df_detail, df_sum = get_investor(url, time_range)
        
        if not df_detail.empty:
            dataframes_detail.append(df_detail)
        else:
            print(f"No detail data collected for {url.split('=')[-1]} ({time_range}).")

        if not df_sum.empty:
            dataframes_sum.append(df_sum)
        else:
            print(f"No summary data collected for {url.split('=')[-1]} ({time_range}).")
        
        progress = ((index + 1) / total_url) * 100
        print(f'Overall progress for {time_range}: {progress:.2f}%')
        
    combined_df_detail = pd.DataFrame()
    if dataframes_detail:
        combined_df_detail = pd.concat(dataframes_detail, ignore_index=True)
        combined_df_detail.drop_duplicates(inplace=True)
    else:
        print(f"No detailed data collected for {time_range} after combining.")

    combined_df_sum = pd.DataFrame()
    if dataframes_sum:
        combined_df_sum = pd.concat(dataframes_sum, ignore_index=True)
        combined_df_sum.drop_duplicates(inplace=True)
    else:
        print(f"No summary data collected for {time_range} after combining.")

    return combined_df_detail, combined_df_sum

def process_data(df):
    """
    Processes the combined detailed DataFrame to pivot and categorize net buy/sell values.
    This function is designed to work with detailed transaction data.
    """
    if df.empty:
        print("Input DataFrame for process_data is empty. Returning empty DataFrame.")
        return pd.DataFrame()

    required_cols = ['ticker', 'foreignNetValueAdd', 'investor', 'fromDate']
    # Check if all required columns exist
    if not all(col in df.columns for col in required_cols):
        missing_cols = [col for col in required_cols if col not in df.columns]
        print(f"Error: Missing required columns for processing detailed data: {', '.join(missing_cols)}")
        return pd.DataFrame()

    # Create a 'marketType' column based on foreignNetValueAdd
    df['marketType'] = np.where(df['foreignNetValueAdd'] > 0, 'Buy', 'Sell')

    # Pivot the DataFrame
    # Use 'first' as aggfunc for value and marketType
    # This assumes ticker/fromDate combination is unique for each investor type's transaction.
    # If a ticker can have multiple transactions for the same investor type on the same date,
    # consider 'sum' for values or a more complex aggregation strategy.
    pivot_df = df.pivot_table(index=['ticker', 'fromDate'],
                              columns='investor',
                              values=['foreignNetValueAdd', 'marketType'],
                              aggfunc='first') # Use 'first' to pick one if duplicates exist

    # Flatten multi-level columns
    # Example: ('foreignNetValueAdd', 'ForeignMatch') -> 'foreignNetValueAdd_ForeignMatch'
    pivot_df.columns = [f'{col[0]}_{col[1]}' if col[1] else col[0] for col in pivot_df.columns]
    pivot_df = pivot_df.reset_index() # Reset index to make 'ticker' and 'fromDate' regular columns

    pivot_df = pivot_df.fillna(0) # Fill NaN from pivot with 0

    # Initialize empty DataFrames for concatenation
    df_td = pd.DataFrame()
    df_tc = pd.DataFrame()
    df_nn = pd.DataFrame()
    df_cn = pd.DataFrame()

    # Process for each investor type, renaming columns for clarity
    # Check for column existence before processing each block
    if 'foreignNetValueAdd_ProprietaryMatch' in pivot_df.columns:
        df_td = pivot_df.loc[pivot_df['foreignNetValueAdd_ProprietaryMatch'] != 0].copy()
        df_td = df_td[['ticker', 'marketType_ProprietaryMatch', 'foreignNetValueAdd_ProprietaryMatch', 'fromDate']]
        df_td.rename(columns={
            'ticker': 'tickerTD',
            'marketType_ProprietaryMatch': 'marketTypeTD',
            'foreignNetValueAdd_ProprietaryMatch': 'TDNetValue', # Changed to NetValue as it can be buy/sell
            'fromDate': 'fromDateTD'
        }, inplace=True)
        df_td.sort_values(by='TDNetValue', ascending=False, inplace=True)
        df_td.reset_index(drop=True, inplace=True)

    if 'foreignNetValueAdd_LocalInstitutionMatch' in pivot_df.columns:
        df_tc = pivot_df.loc[pivot_df['foreignNetValueAdd_LocalInstitutionMatch'] != 0].copy()
        df_tc = df_tc[['ticker', 'marketType_LocalInstitutionMatch', 'foreignNetValueAdd_LocalInstitutionMatch', 'fromDate']]
        df_tc.rename(columns={
            'ticker': 'tickerTC',
            'marketType_LocalInstitutionMatch': 'marketTypeTC',
            'foreignNetValueAdd_LocalInstitutionMatch': 'TCTNNetValue', # Changed to NetValue
            'fromDate': 'fromDateTC'
        }, inplace=True)
        df_tc.sort_values(by='TCTNNetValue', ascending=False, inplace=True)
        df_tc.reset_index(drop=True, inplace=True)

    if 'foreignNetValueAdd_ForeignMatch' in pivot_df.columns:
        df_nn = pivot_df.loc[pivot_df['foreignNetValueAdd_ForeignMatch'] != 0].copy()
        df_nn = df_nn[['ticker', 'marketType_ForeignMatch', 'foreignNetValueAdd_ForeignMatch', 'fromDate']]
        df_nn.rename(columns={
            'ticker': 'tickerNN',
            'marketType_ForeignMatch': 'marketTypeNN',
            'foreignNetValueAdd_ForeignMatch': 'NNNetValue', # Changed to NetValue
            'fromDate': 'fromDateNN'
        }, inplace=True)
        df_nn.sort_values(by='NNNetValue', ascending=False, inplace=True)
        df_nn.reset_index(drop=True, inplace=True)

    if 'foreignNetValueAdd_LocalIndividualMatch' in pivot_df.columns:
        df_cn = pivot_df.loc[pivot_df['foreignNetValueAdd_LocalIndividualMatch'] != 0].copy()
        df_cn = df_cn[['ticker', 'marketType_LocalIndividualMatch', 'foreignNetValueAdd_LocalIndividualMatch', 'fromDate']]
        df_cn.rename(columns={
            'ticker': 'tickerCn',
            'marketType_LocalIndividualMatch': 'marketTypeCN',
            'foreignNetValueAdd_LocalIndividualMatch': 'NDTCNNetValue', # Changed to NetValue
            'fromDate': 'fromDateCN'
        }, inplace=True)
        df_cn.sort_values(by='NDTCNNetValue', ascending=False, inplace=True)
        df_cn.reset_index(drop=True, inplace=True)

    # Concatenate all processed DataFrames along columns (axis=1)
    # This creates a wide DataFrame with columns for each investor type.
    # Rows will be aligned by their integer index after reset_index(drop=True).
    # If investor types have different number of rows after filtering, this will introduce NaNs.
    final_combined_df = pd.concat([df_td, df_tc, df_nn, df_cn], axis=1)

    return final_combined_df

def main():
    """Main function to orchestrate data fetching, processing, and saving."""
    print(f"Starting bot at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    urls = [
        'https://wl-market.fiintrade.vn/MoneyFlow/GetStatisticInvestor?language=vi&comGroupCode=VNINDEX&investorType=LocalIndividualMatch',
        'https://wl-market.fiintrade.vn/MoneyFlow/GetStatisticInvestor?language=vi&comGroupCode=VNINDEX&investorType=LocalInstitutionMatch',
        'https://wl-market.fiintrade.vn/MoneyFlow/GetStatisticInvestor?language=vi&comGroupCode=VNINDEX&investorType=ProprietaryMatch',
        'https://wl-market.fiintrade.vn/MoneyFlow/GetStatisticInvestor?language=vi&comGroupCode=VNINDEX&investorType=ForeignMatch'
    ]
    
    time_ranges = ['today', 'oneWeek', 'oneMonth', 'yearToDate']
    all_sum_data = []

    # Define file paths
    # Changed investor_detail.xlsx to investor.xlsx as requested
    investor_file_path = os.path.join(data_dir, 'investor.xlsx') 
    sum_file_path = os.path.join(data_dir, 'investor_sum.xlsx')

    try:
        # --- Process and save detailed data to investor.xlsx ---
        print(f"\n--- Starting to write investor.xlsx (detailed data) ---")
        print(f"File path: {investor_file_path}")
        with pd.ExcelWriter(investor_file_path, engine='openpyxl') as writer_investor:
            for time_range in time_ranges:
                print(f"\nProcessing detailed data for time range: '{time_range}'...")
                df_detail, df_sum = get_investor_all(urls, time_range)
                
                # Process and save detailed data to its specific sheet
                if not df_detail.empty:
                    processed_df = process_data(df_detail)
                    if not processed_df.empty:
                        # Round all numeric columns to 2 decimal places
                        # Select only numeric columns to avoid error with string columns
                        for col in processed_df.select_dtypes(include=np.number).columns:
                            processed_df[col] = processed_df[col].round(2)
                        
                        try:
                            processed_df.to_excel(writer_investor, sheet_name=time_range, index=False)
                            print(f"Successfully wrote detailed data for {time_range} to sheet '{time_range}' in '{investor_file_path}'.")
                        except Exception as e:
                            print(f"Error writing detailed data for {time_range} to Excel: {e}")
                            print(f"DataFrame head for {time_range} that caused error:\n{processed_df.head()}")
                            print(f"DataFrame dtypes for {time_range} that caused error:\n{processed_df.dtypes}")
                    else:
                        print(f"Processed data for {time_range} is empty, not writing to sheet '{time_range}'.")
                else:
                    print(f"No raw detailed data collected for {time_range} for processing.")

                # Collect summary data for later combined saving
                if not df_sum.empty:
                    all_sum_data.append(df_sum)
                else:
                    print(f"No summary data to collect for {time_range} for later combined saving.")
        print(f"Finished writing detailed data to '{investor_file_path}'.")

        # --- Combine and save summary data to investor_sum.xlsx ---
        print(f"\n--- Starting to write investor_sum.xlsx (summary data) ---")
        print(f"File path: {sum_file_path}")
        if all_sum_data:
            combined_sum_df = pd.concat(all_sum_data, ignore_index=True)
            combined_sum_df.drop_duplicates(inplace=True) # Ensure no duplicate rows in combined summary
            
            # Round all numeric columns to 2 decimal places in combined_sum_df
            for col in combined_sum_df.select_dtypes(include=np.number).columns:
                combined_sum_df[col] = combined_sum_df[col].round(2)
            
            try:
                with pd.ExcelWriter(sum_file_path, engine='openpyxl') as writer_sum:
                    combined_sum_df.to_excel(writer_sum, sheet_name='Summary', index=False)
                print(f"Successfully wrote combined summary data to '{sum_file_path}'.")
            except Exception as e:
                print(f"Error writing combined summary data to Excel: {e}")
                print(f"Combined Summary DataFrame head that caused error:\n{combined_sum_df.head()}")
                print(f"Combined Summary DataFrame dtypes that caused error:\n{combined_sum_df.dtypes}")
        else:
            print("No summary data was collected. 'investor_sum.xlsx' will not be created or updated.")
        
    except Exception as e:
        print(f"An overarching error occurred during file operations or data processing: {e}")

    print('\nAll tasks completed.')

if __name__ == '__main__':
    main()