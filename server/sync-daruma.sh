#!/bin/sh
# だるまの決まり（sphosino/daruma の rules.js と old/daruma-core.js）を、サーバーに写す。決まりを変えたら、これを動かしてから deploy する
#   サーバーは "type": "module" なので、CommonJS のまま読めるように .cjs にする
set -e
D=../../daruma
mkdir -p src/daruma
sed 's#require("./old/daruma-core.js")#require("./daruma-core.cjs")#' "$D/rules.js" > src/daruma/rules.cjs
cp "$D/old/daruma-core.js" src/daruma/daruma-core.cjs
echo "写しました：src/daruma/rules.cjs・daruma-core.cjs"
