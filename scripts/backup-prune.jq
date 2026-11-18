# Which backups to delete. Input: the Storage listing (array of {name}); --argjson now <epoch seconds>.
#   keep every backup from the last 3 days, then only the newest backup of each day up to 30 days, delete everything older.
def ts: capture("njpos-db-(?<d>[0-9]{4}-[0-9]{2}-[0-9]{2})_(?<h>[0-9]{2})(?<m>[0-9]{2})") | (.d + "T" + .h + ":" + .m + ":00Z") | fromdateiso8601;
def day: capture("njpos-db-(?<d>[0-9]{4}-[0-9]{2}-[0-9]{2})_").d;
[ .[] | select(.name | test("^njpos-db-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}")) | {name, ts: (.name | ts), day: (.name | day)} ] as $all
| ($all | map(select(.ts < ($now - 3*86400) and .ts >= ($now - 30*86400))) | group_by(.day) | map(max_by(.ts).name)) as $newestOfDay
| $all
| map(select(.ts < ($now - 30*86400) or (.ts < ($now - 3*86400) and ((.name as $n | $newestOfDay | index($n)) == null))))
| map("daily/" + .name)
