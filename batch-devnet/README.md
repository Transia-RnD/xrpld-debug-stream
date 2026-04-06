git checkout develop && \
git pull && \
git checkout -b tmp-batch-db develop && \
git merge --squash batch-db && \
git commit -m "feature" && \
git checkout batch-db && \
git reset --hard tmp-batch-db && \
git push -f && \
git branch -D tmp-batch-db