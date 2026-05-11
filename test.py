#!/usr/bin/env python3
import time
import sys

print("🤖 IROTECH Bot Started Successfully!")
print("Bot is now running...")

counter = 0
while True:
    counter += 1
    print(f"[{time.strftime('%H:%M:%S')}] Bot heartbeat #{counter}")
    time.sleep(5)