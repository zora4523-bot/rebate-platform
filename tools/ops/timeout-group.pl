#!/usr/bin/perl
# timeout-group.pl <seconds> <command> [args...]
#
# Runs the command in its own process group. When the time limit passes, the
# whole group gets TERM, then KILL after COULI_KILL_GRACE_SECS (default 5) if
# any member is still alive (规划/11 §2.4 "超时": killing only the outer process
# leaves its children running). Exit code: the command's own, 124 on timeout,
# 128+N when the command died from signal N, 127 when it could not be started.
use strict;
use warnings;
use POSIX qw(:sys_wait_h);

my $limit = shift @ARGV;
die "usage: timeout-group.pl <seconds> <command> [args...]\n"
  unless defined $limit && $limit =~ /^[1-9][0-9]*$/ && @ARGV;
my $grace = $ENV{COULI_KILL_GRACE_SECS};
$grace = 5 unless defined $grace && $grace =~ /^[0-9]+$/;

my $pid = fork();
die "fork failed: $!\n" unless defined $pid;
if ($pid == 0) {
  setpgrp(0, 0);
  no warnings 'exec';
  exec { $ARGV[0] } @ARGV or do {
    print STDERR "cannot run $ARGV[0]: $!\n";
    POSIX::_exit(127);
  };
}

my $timed_out = 0;
my $status = 0;
my $reaped = 0;

# Perl restarts waitpid() after a signal handler returns, so the handler itself
# has to do the killing.
local $SIG{ALRM} = sub {
  $timed_out = 1;
  kill 'TERM', -$pid;
  my $deadline = time + $grace;
  while (time < $deadline) {
    if (!$reaped && waitpid($pid, WNOHANG) == $pid) {
      $status = $?;
      $reaped = 1;
    }
    # The group is gone once the leader is reaped and no member answers.
    last if $reaped && !kill(0, -$pid);
    select(undef, undef, undef, 0.1);
  }
  kill 'KILL', -$pid;
};
alarm $limit;

if (waitpid($pid, 0) == $pid) {
  $status = $?;
  $reaped = 1;
}
alarm 0;

exit 124 if $timed_out;
exit(128 + ($status & 127)) if $status & 127;
exit($status >> 8);
